//! Shared SSRF / URL-safety guard.
//!
//! Consolidates the browser `packages/browser/src/ssrf.ts` string/hostname
//! checker with the stronger IP-based checks from `commands/api_proxy.rs`
//! (`is_blocked_external_ip`, `validate_external_url`). This is the single
//! authoritative defense-in-depth check at the IPC boundary.
//!
//! Semantics:
//! - Block `file/ftp/sftp/gopher/dict/ldap/ldaps` and metadata hosts.
//! - Block private / loopback destinations by default (unless `allowPrivateUrls`
//!   or `allowedHosts` opts in).
//! - `validate_external_url` is the `api_proxy`-parity async DNS guard
//!   (https-only, local-http exception) for reuse by `api_proxy`/`context_refs`.
//! - `validate_navigate_url` is the browser-friendly async DNS guard
//!   (http/https) used by `browser_navigate` to close the DNS-rebinding gap
//!   without rejecting legitimate public http navigation.

use std::net::IpAddr;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

const BLOCKED_SCHEMES: &[&str] = &["file", "ftp", "sftp", "gopher", "dict", "ldap", "ldaps"];
const BLOCKED_HOST_SUFFIXES: &[&str] = &[".localhost", ".local"];
const ALWAYS_BLOCKED_HOSTS: &[&str] = &[
    "metadata.google.internal",
    "metadata.google.internal.",
    "169.254.169.254",
];

/// Options controlling SSRF evaluation.
///
/// This is an input struct (borrowed slice), not a serde mirror, so it does not
/// derive `Deserialize`.
#[derive(Debug, Clone, PartialEq)]
pub struct SsrfOptions<'a> {
    pub allow_private_urls: bool,
    pub allowed_hosts: &'a [String],
}

/// Result of evaluating a URL for safety.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UrlSafetyResult {
    pub safe: bool,
    pub normalized_url: String,
    pub reason: Option<String>,
}

/// Normalize a URL string for request use (collapse `.` / `..` path segments).
pub fn normalize_url_for_request(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    match url::Url::parse(trimmed) {
        Ok(mut parsed) => {
            let normalized = normalize_path(parsed.path());
            parsed.set_path(&normalized);
            parsed.to_string()
        }
        Err(_) => trimmed.to_string(),
    }
}

/// Collapse `.` and `..` path segments (mirrors `ssrf.ts::normalizePath`).
fn normalize_path(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    let mut out: Vec<&str> = Vec::new();
    for part in parts {
        if part == ".." {
            out.pop();
        } else if part != "." {
            out.push(part);
        }
    }
    let joined = out.join("/");
    if joined.is_empty() {
        "/".to_string()
    } else {
        joined
    }
}

/// Return true if a URL should always be blocked regardless of settings.
pub fn is_always_blocked_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    let url = match url::Url::parse(trimmed) {
        Ok(u) => u,
        Err(_) => return true,
    };
    if BLOCKED_SCHEMES.contains(&url.scheme()) {
        return true;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if ALWAYS_BLOCKED_HOSTS.contains(&host.as_str()) {
        return true;
    }
    false
}

/// Hostname string as WHATWG `URL.hostname` would produce it (IPv6 bracketed).
fn url_hostname(url: &url::Url) -> String {
    match url.host() {
        Some(url::Host::Domain(host)) => host.to_string().to_ascii_lowercase(),
        Some(url::Host::Ipv4(ip)) => ip.to_string(),
        Some(url::Host::Ipv6(ip)) => format!("[{}]", ip),
        None => String::new(),
    }
}

/// String/hostname private check (mirrors `ssrf.ts::isPrivateHost`).
fn is_private_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower == "[::1]" || lower == "::1" {
        return true;
    }
    if lower.starts_with("127.") {
        return true;
    }
    if lower.starts_with("10.") {
        return true;
    }
    if lower.starts_with("192.168.") {
        return true;
    }
    if lower.starts_with("172.") {
        let second = lower
            .split('.')
            .nth(1)
            .and_then(|s| s.parse::<i32>().ok())
            .unwrap_or(0);
        if (16..=31).contains(&second) {
            return true;
        }
    }
    if lower.starts_with("fc00:") || lower.starts_with("fe80:") {
        return true;
    }
    for suffix in BLOCKED_HOST_SUFFIXES {
        if lower.ends_with(suffix) {
            return true;
        }
    }
    false
}

/// Check an allowed-host whitelist (mirrors `ssrf.ts::isAllowedHost`).
fn is_allowed_host(host: &str, allowed_hosts: &[String]) -> bool {
    if allowed_hosts.is_empty() {
        return false;
    }
    let lower = host.to_ascii_lowercase();
    for pattern in allowed_hosts {
        let p = pattern.to_ascii_lowercase();
        if lower == p
            || lower.ends_with(&format!(".{p}"))
            || (p.starts_with("*.") && lower.ends_with(&p[1..]))
        {
            return true;
        }
    }
    false
}

/// Whether a URL's host is private / loopback (stronger for IP literals).
fn host_is_private(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => is_private_host(&host.to_ascii_lowercase()),
        Some(url::Host::Ipv4(ip)) => is_blocked_external_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_blocked_external_ip(IpAddr::V6(ip)),
        None => false,
    }
}

/// Evaluate whether a URL is safe to load in the browser.
pub fn evaluate_url_safety(raw: &str, opts: &SsrfOptions) -> UrlSafetyResult {
    let normalized_url = normalize_url_for_request(raw);
    if normalized_url.is_empty() {
        return UrlSafetyResult {
            safe: false,
            normalized_url,
            reason: Some("empty or invalid URL".to_string()),
        };
    }
    if is_always_blocked_url(&normalized_url) {
        return UrlSafetyResult {
            safe: false,
            normalized_url,
            reason: Some("URL matches always-blocked list".to_string()),
        };
    }
    let url = match url::Url::parse(&normalized_url) {
        Ok(u) => u,
        Err(_) => {
            return UrlSafetyResult {
                safe: false,
                normalized_url,
                reason: Some("invalid URL".to_string()),
            };
        }
    };
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return UrlSafetyResult {
            safe: false,
            normalized_url,
            reason: Some(format!("scheme {scheme} is not allowed")),
        };
    }
    let host = url_hostname(&url);
    if !opts.allow_private_urls
        && host_is_private(&url)
        && !is_allowed_host(&host, opts.allowed_hosts)
    {
        return UrlSafetyResult {
            safe: false,
            normalized_url,
            reason: Some("private/loopback URL is not allowed".to_string()),
        };
    }
    UrlSafetyResult {
        safe: true,
        normalized_url,
        reason: None,
    }
}

/// Convenience guard: returns the normalized URL or `AppError::InvalidRequest`.
pub fn assert_safe_url(raw: &str, opts: &SsrfOptions) -> Result<String, AppError> {
    let result = evaluate_url_safety(raw, opts);
    if !result.safe {
        return Err(AppError::InvalidRequest(format!(
            "Unsafe URL: {}",
            result.reason.unwrap_or_default()
        )));
    }
    Ok(result.normalized_url)
}

/// Redact a raw CDP URL so secrets in path segments or sensitive query params
/// are not leaked into snapshots/logs.
pub fn redact_cdp_url(raw: &str) -> String {
    let url = match url::Url::parse(raw) {
        Ok(u) => u,
        Err(_) => return "<redacted-cdp-url>".to_string(),
    };
    let scheme = url.scheme().to_string();
    let mut host_port = url_hostname(&url);
    if let Some(port) = url.port() {
        host_port.push(':');
        host_port.push_str(&port.to_string());
    }

    let mut parts: Vec<&str> = url.path().split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 2 {
        parts.pop();
        parts.push("<redacted>");
    }
    let pathname = format!("/{}", parts.join("/"));

    let mut search_entries: Vec<String> = Vec::new();
    for (key, value) in url.query_pairs() {
        let key = key.to_string();
        if is_sensitive_query_key(&key) {
            search_entries.push(format!("{key}=<redacted>"));
        } else {
            search_entries.push(format!("{key}={}", encode_uri_component(value.as_ref())));
        }
    }
    let search = if search_entries.is_empty() {
        String::new()
    } else {
        format!("?{}", search_entries.join("&"))
    };
    let hash = url.fragment().map(|f| format!("#{f}")).unwrap_or_default();

    format!("{scheme}//{host_port}{pathname}{search}{hash}")
}

fn is_sensitive_query_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("token")
        || k.contains("key")
        || k.contains("secret")
        || k.contains("auth")
        || k.contains("password")
}

/// Approximate JavaScript `encodeURIComponent` for ASCII/UTF-8 bytes.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        let allowed = b.is_ascii_alphanumeric()
            || b == b'-'
            || b == b'_'
            || b == b'.'
            || b == b'!'
            || b == b'~'
            || b == b'*'
            || b == b'\''
            || b == b'('
            || b == b')';
        if allowed {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Whether an IP address must never be reached by an external request.
pub fn is_blocked_external_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_blocked_external_ip(IpAddr::V4(v4)))
        }
    }
}

pub fn is_allowed_local_external_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_unspecified(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
    }
}

pub fn is_allowed_local_external_domain(host: &str) -> bool {
    let lower_host = host.trim_end_matches('.').to_ascii_lowercase();
    lower_host == "localhost" || lower_host.ends_with(".localhost")
}

pub fn is_allowed_local_external_url(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => is_allowed_local_external_domain(host),
        Some(url::Host::Ipv4(ip)) => is_allowed_local_external_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_allowed_local_external_ip(IpAddr::V6(ip)),
        None => false,
    }
}

/// Shape-only validation (sync) for the `api_proxy` external request guard.
pub fn validate_external_url_shape(raw: &str) -> Result<url::Url, AppError> {
    let url = url::Url::parse(raw)?;
    let is_local_url = is_allowed_local_external_url(&url);
    if url.scheme() != "https" && !(url.scheme() == "http" && is_local_url) {
        return Err(AppError::InvalidRequest(
            "external_request only allows https URLs; http is only allowed for local URLs"
                .to_string(),
        ));
    }

    match url.host().ok_or_else(|| {
        AppError::InvalidRequest("external_request URL must include a host".to_string())
    })? {
        url::Host::Domain(_) => {}
        url::Host::Ipv4(ip) => {
            let ip = IpAddr::V4(ip);
            if !is_allowed_local_external_ip(ip) && is_blocked_external_ip(ip) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses private or local IP targets".to_string(),
                ));
            }
        }
        url::Host::Ipv6(ip) => {
            let ip = IpAddr::V6(ip);
            if !is_allowed_local_external_ip(ip) && is_blocked_external_ip(ip) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses private or local IP targets".to_string(),
                ));
            }
        }
    }

    Ok(url)
}

/// Async DNS-resolution guard (consolidated from `api_proxy.rs`). Keeps the
/// same https-only + local-http semantics so `api_proxy` / `context_refs` can
/// re-export this unchanged.
pub async fn validate_external_url(raw: &str) -> Result<url::Url, AppError> {
    let url = validate_external_url_shape(raw)?;

    if let Some(url::Host::Domain(host)) = url.host() {
        if is_allowed_local_external_domain(host) {
            return Ok(url);
        }
        let port = url.port_or_known_default().ok_or_else(|| {
            AppError::InvalidRequest("external_request URL must include a port".to_string())
        })?;
        let resolved = tokio::net::lookup_host((host, port)).await.map_err(|e| {
            AppError::InvalidRequest(format!("external_request DNS lookup failed: {e}"))
        })?;
        for addr in resolved {
            if is_blocked_external_ip(addr.ip()) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses hosts resolving to private or local IPs".to_string(),
                ));
            }
        }
    }

    Ok(url)
}

/// Browser-friendly async DNS guard: allows both http and https, then rejects
/// any destination that resolves to a blocked (private/loopback/link-local) IP.
/// Used by `browser_navigate` to close the DNS-rebinding gap.
pub async fn validate_navigate_url(raw: &str) -> Result<url::Url, AppError> {
    let url = url::Url::parse(raw)?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(AppError::InvalidRequest(format!(
            "Unsafe URL: scheme {} is not allowed",
            url.scheme()
        )));
    }
    let host = url
        .host()
        .ok_or_else(|| AppError::InvalidRequest("URL must include a host".to_string()))?;

    match host {
        url::Host::Domain(domain) => {
            // Reject loopback-style domain names without a DNS round-trip.
            if is_private_host(&domain.to_ascii_lowercase()) {
                return Err(AppError::InvalidRequest(
                    "Unsafe URL: private/loopback URL is not allowed".to_string(),
                ));
            }
            let port = url
                .port_or_known_default()
                .ok_or_else(|| AppError::InvalidRequest("URL must include a port".to_string()))?;
            let resolved: Vec<std::net::SocketAddr> = tokio::net::lookup_host((domain, port))
                .await
                .map_err(|e| {
                    AppError::InvalidRequest(format!("Unsafe URL: DNS lookup failed: {e}"))
                })?
                .collect();
            if resolved.is_empty() {
                return Err(AppError::InvalidRequest(
                    "Unsafe URL: DNS lookup returned no addresses".to_string(),
                ));
            }
            for addr in resolved {
                if is_blocked_external_ip(addr.ip()) {
                    return Err(AppError::InvalidRequest(
                        "Unsafe URL: private/loopback URL is not allowed".to_string(),
                    ));
                }
            }
        }
        url::Host::Ipv4(ip) => {
            if is_blocked_external_ip(IpAddr::V4(ip)) {
                return Err(AppError::InvalidRequest(
                    "Unsafe URL: private/loopback URL is not allowed".to_string(),
                ));
            }
        }
        url::Host::Ipv6(ip) => {
            if is_blocked_external_ip(IpAddr::V6(ip)) {
                return Err(AppError::InvalidRequest(
                    "Unsafe URL: private/loopback URL is not allowed".to_string(),
                ));
            }
        }
    }

    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    const PUBLIC_OPTS: SsrfOptions<'static> = SsrfOptions {
        allow_private_urls: false,
        allowed_hosts: &[],
    };

    fn opts_allow_private() -> SsrfOptions<'static> {
        SsrfOptions {
            allow_private_urls: true,
            allowed_hosts: &[],
        }
    }

    fn opts_allowed(hosts: &[String]) -> SsrfOptions<'_> {
        SsrfOptions {
            allow_private_urls: false,
            allowed_hosts: hosts,
        }
    }

    #[test]
    fn normalize_url_collapses_path_traversal() {
        assert_eq!(
            normalize_url_for_request("https://example.com/foo/../bar"),
            "https://example.com/bar"
        );
    }

    #[test]
    fn normalize_url_returns_trimmed_for_invalid_url() {
        assert_eq!(normalize_url_for_request("not a url"), "not a url");
    }

    #[test]
    fn normalize_url_returns_empty_for_empty_string() {
        assert_eq!(normalize_url_for_request("  "), "");
    }

    #[test]
    fn is_always_blocked_blocks_file_scheme() {
        assert!(is_always_blocked_url("file:///etc/passwd"));
    }

    #[test]
    fn is_always_blocked_blocks_ftp_scheme() {
        assert!(is_always_blocked_url("ftp://example.com"));
    }

    #[test]
    fn is_always_blocked_blocks_metadata_endpoint() {
        assert!(is_always_blocked_url(
            "http://169.254.169.254/latest/meta-data/"
        ));
    }

    #[test]
    fn is_always_blocked_allows_public_http() {
        assert!(!is_always_blocked_url("https://example.com"));
    }

    #[test]
    fn evaluate_allows_public_https() {
        let result = evaluate_url_safety("https://example.com/path?query=1", &PUBLIC_OPTS);
        assert!(result.safe);
        assert_eq!(result.normalized_url, "https://example.com/path?query=1");
    }

    #[test]
    fn evaluate_blocks_file_urls() {
        let result = evaluate_url_safety("file:///etc/passwd", &PUBLIC_OPTS);
        assert!(!result.safe);
        assert!(result.reason.as_deref().unwrap().contains("always-blocked"));
    }

    #[test]
    fn evaluate_blocks_localhost_by_default() {
        let result = evaluate_url_safety("http://localhost:8080/", &PUBLIC_OPTS);
        assert!(!result.safe);
        assert!(result
            .reason
            .as_deref()
            .unwrap()
            .contains("private/loopback"));
    }

    #[test]
    fn evaluate_blocks_loopback_ipv4() {
        assert!(!evaluate_url_safety("http://127.0.0.1/", &PUBLIC_OPTS).safe);
    }

    #[test]
    fn evaluate_blocks_loopback_ipv6() {
        assert!(!evaluate_url_safety("http://[::1]:3000/", &PUBLIC_OPTS).safe);
    }

    #[test]
    fn evaluate_blocks_private_10_x() {
        assert!(!evaluate_url_safety("http://10.0.0.1/", &PUBLIC_OPTS).safe);
    }

    #[test]
    fn evaluate_blocks_private_192_168_x() {
        assert!(!evaluate_url_safety("http://192.168.1.1/", &PUBLIC_OPTS).safe);
    }

    #[test]
    fn evaluate_blocks_private_172_16_31() {
        assert!(!evaluate_url_safety("http://172.16.0.1/", &PUBLIC_OPTS).safe);
        assert!(!evaluate_url_safety("http://172.31.255.255/", &PUBLIC_OPTS).safe);
        assert!(evaluate_url_safety("http://172.15.0.1/", &PUBLIC_OPTS).safe);
    }

    #[test]
    fn evaluate_blocks_local_suffix() {
        assert!(!evaluate_url_safety("http://printer.local/", &PUBLIC_OPTS).safe);
    }

    #[test]
    fn evaluate_allows_private_when_opted_in() {
        assert!(evaluate_url_safety("http://localhost:8080/", &opts_allow_private()).safe);
    }

    #[test]
    fn evaluate_respects_allowed_hosts() {
        let hosts = vec!["localhost".to_string()];
        assert!(evaluate_url_safety("http://localhost:8080/", &opts_allowed(&hosts)).safe);
    }

    #[test]
    fn evaluate_rejects_non_http_schemes() {
        let result = evaluate_url_safety("javascript:alert(1)", &PUBLIC_OPTS);
        assert!(!result.safe);
        assert!(result.reason.as_deref().unwrap().contains("scheme"));
    }

    #[test]
    fn assert_safe_url_returns_normalized() {
        assert_eq!(
            assert_safe_url("https://example.com", &PUBLIC_OPTS).unwrap(),
            "https://example.com/"
        );
    }

    #[test]
    fn assert_safe_url_errors_for_unsafe() {
        let err = assert_safe_url("file:///etc/passwd", &PUBLIC_OPTS).unwrap_err();
        assert!(err.to_string().contains("Unsafe URL"));
        assert!(matches!(err, AppError::InvalidRequest(_)));
    }

    #[test]
    fn redact_cdp_url_redacts_browserbase_token_in_path() {
        let redacted = redact_cdp_url("wss://api.browserbase.com/v1/sessions/abc-123?token=secret");
        assert!(!redacted.contains("abc-123"));
        assert!(!redacted.contains("secret"));
        assert!(!redacted.contains("%3Credacted%3E"));
    }

    #[test]
    fn redact_cdp_url_returns_placeholder_for_non_url() {
        assert_eq!(redact_cdp_url("not a url"), "<redacted-cdp-url>");
    }

    // ---- Rust-only additional coverage ----

    #[test]
    fn is_blocked_external_ip_blocks_ipv4_mapped_ipv6() {
        let ipv4_mapped_loopback = IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001));
        assert!(is_blocked_external_ip(ipv4_mapped_loopback));

        let ipv4_mapped_private = IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001));
        assert!(is_blocked_external_ip(ipv4_mapped_private));
    }

    #[test]
    fn is_blocked_external_ip_blocks_decimal_ipv4() {
        let ip = IpAddr::V4(Ipv4Addr::from(2130706433u32));
        assert!(is_blocked_external_ip(ip));
    }

    #[test]
    fn evaluate_blocks_decimal_ip_literal() {
        let result = evaluate_url_safety("http://2130706433/", &PUBLIC_OPTS);
        assert!(!result.safe);
        assert!(result
            .reason
            .as_deref()
            .unwrap()
            .contains("private/loopback"));
    }

    #[test]
    fn validate_external_url_shape_requires_https() {
        let err = validate_external_url_shape("http://api.example.com/models").unwrap_err();
        assert!(err.to_string().contains("only allows https"));
    }

    #[test]
    fn validate_external_url_shape_rejects_private_ip_literals() {
        for raw in [
            "https://10.0.0.1/status",
            "https://172.16.0.1/status",
            "https://192.168.1.1/status",
            "https://169.254.169.254/latest/meta-data",
            "https://[fc00::1]/status",
            "https://[fe80::1]/status",
        ] {
            let err = validate_external_url_shape(raw).unwrap_err();
            assert!(
                err.to_string().contains("private or local"),
                "unexpected error for {raw}: {err}"
            );
        }
    }

    #[tokio::test]
    async fn validate_external_url_allows_localhost_without_dns_rejection() {
        let url = validate_external_url("http://localhost:1234/v1/models")
            .await
            .unwrap();
        assert_eq!(url.host_str(), Some("localhost"));
    }

    #[tokio::test]
    async fn validate_external_url_rejects_private_ip_literals() {
        for raw in [
            "https://10.0.0.1/status",
            "https://172.16.0.1/status",
            "https://192.168.1.1/status",
        ] {
            assert!(
                validate_external_url(raw).await.is_err(),
                "expected error for {raw}"
            );
        }
    }

    #[tokio::test]
    async fn validate_navigate_url_rejects_loopback_domain() {
        let err = validate_navigate_url("http://localhost:8080/")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("private/loopback"));
    }

    #[tokio::test]
    async fn validate_navigate_url_rejects_private_ip_literal() {
        let err = validate_navigate_url("http://127.0.0.1/")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("private/loopback"));
    }

    #[tokio::test]
    async fn validate_navigate_url_rejects_link_local_ip_literal() {
        let err = validate_navigate_url("http://169.254.169.254/latest/meta-data")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("private/loopback"));
    }

    #[tokio::test]
    async fn validate_navigate_url_rejects_non_http_scheme() {
        let err = validate_navigate_url("file:///etc/passwd")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("scheme"));
    }
}
