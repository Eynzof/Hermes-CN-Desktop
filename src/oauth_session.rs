//! OAuth/cookie session support for gated remote dashboards (Core v0.18.2+).
//!
//! Non-loopback dashboards enforce `dashboard_auth`: a cookie gate
//! (`hermes_session_at` ~15min / `hermes_session_rt` 24h, rotating) instead
//! of the legacy `X-Hermes-Session-Token` header. The official Electron
//! desktop rides this via a persistent webview partition cookie jar; our
//! REST/WS both go through Rust (reqwest / tokio-tungstenite), so we manage
//! the cookie jar in Rust and reuse it across every dashboard-facing request.
//!
//! Because the server transparently rotates the refresh token on every
//! silent access-token refresh — WITH reuse detection — a rotated RT that we
//! fail to persist would, on the next refresh, look like a stolen token and
//! revoke the whole session. So `SessionCookieJar` captures Set-Cookie on
//! every response and flags itself dirty; callers persist promptly.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use reqwest::header::HeaderValue;
use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// Access-token cookie names, most-hardened first. Mirrors the official
/// desktop's `AT_COOKIE_NAMES` (connection-config.ts): the `__Host-` /
/// `__Secure-` prefix depends on the gateway's HTTPS + path-prefix form.
pub const AT_COOKIE_VARIANTS: [&str; 3] = [
    "__Host-hermes_session_at",
    "__Secure-hermes_session_at",
    "hermes_session_at",
];
/// Refresh-token cookie names, same ordering.
pub const RT_COOKIE_VARIANTS: [&str; 3] = [
    "__Host-hermes_session_rt",
    "__Secure-hermes_session_rt",
    "hermes_session_rt",
];

const SESSION_HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// A cookie as persisted in connection.json (`session.cookies[]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedCookie {
    pub name: String,
    pub value: String,
    /// Absolute expiry in epoch millis, if the Set-Cookie had Max-Age/Expires.
    /// Session cookies (no expiry) omit this. Local expiry is only a display
    /// optimization — liveness is authoritatively decided by minting a ticket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
struct StoredCookie {
    value: String,
    expires_at_ms: Option<u64>,
}

impl StoredCookie {
    fn is_expired(&self, now: u64) -> bool {
        self.expires_at_ms.map(|exp| exp <= now).unwrap_or(false)
    }
}

/// A `reqwest::cookie::CookieStore` scoped to one dashboard origin. reqwest
/// calls `set_cookies` on every response (capturing AT/RT rotation for free)
/// and `cookies` on every request.
#[derive(Debug)]
pub struct SessionCookieJar {
    /// (host, port, https) the jar is bound to — cookies only flow to/from
    /// the exact dashboard origin (defence in depth alongside redirect::none).
    host: String,
    port: Option<u16>,
    cookies: Mutex<HashMap<String, StoredCookie>>,
    dirty: AtomicBool,
}

impl SessionCookieJar {
    fn new(base_url: &Url) -> Self {
        Self {
            host: base_url.host_str().unwrap_or_default().to_string(),
            port: base_url.port_or_known_default(),
            cookies: Mutex::new(HashMap::new()),
            dirty: AtomicBool::new(false),
        }
    }

    fn url_in_scope(&self, url: &Url) -> bool {
        url.host_str() == Some(self.host.as_str()) && url.port_or_known_default() == self.port
    }

    fn import(&self, cookies: &[PersistedCookie]) {
        let now = now_ms();
        let mut guard = self.cookies.lock().unwrap();
        guard.clear();
        for c in cookies {
            let stored = StoredCookie {
                value: c.value.clone(),
                expires_at_ms: c.expires_at_ms,
            };
            if !stored.is_expired(now) {
                guard.insert(c.name.clone(), stored);
            }
        }
        // Importing persisted state is not a change worth writing back.
        self.dirty.store(false, Ordering::Relaxed);
    }

    fn export(&self) -> Vec<PersistedCookie> {
        let now = now_ms();
        let guard = self.cookies.lock().unwrap();
        let mut out: Vec<PersistedCookie> = guard
            .iter()
            .filter(|(_, v)| !v.is_expired(now))
            .map(|(name, v)| PersistedCookie {
                name: name.clone(),
                value: v.value.clone(),
                expires_at_ms: v.expires_at_ms,
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    fn has_variant(&self, variants: &[&str]) -> bool {
        let now = now_ms();
        let guard = self.cookies.lock().unwrap();
        variants.iter().any(|name| {
            guard
                .get(*name)
                .map(|c| !c.is_expired(now))
                .unwrap_or(false)
        })
    }

    fn clear(&self) {
        let mut guard = self.cookies.lock().unwrap();
        if !guard.is_empty() {
            guard.clear();
            self.dirty.store(true, Ordering::Relaxed);
        }
    }

    fn take_dirty(&self) -> bool {
        self.dirty.swap(false, Ordering::Relaxed)
    }

    /// Parse one Set-Cookie header value and apply it (insert / update /
    /// delete on Max-Age<=0 or a past Expires).
    fn apply_set_cookie(&self, raw: &str) {
        let Ok(parsed) = cookie::Cookie::parse(raw.to_string()) else {
            return;
        };
        let name = parsed.name().to_string();
        let value = parsed.value().to_string();

        // Deletion: Max-Age <= 0, or an Expires in the past.
        let deleting = parsed
            .max_age()
            .map(|d| d.whole_seconds() <= 0)
            .unwrap_or(false)
            || parsed
                .expires_datetime()
                .map(|t| t.unix_timestamp() <= (now_ms() / 1000) as i64)
                .unwrap_or(false);

        let mut guard = self.cookies.lock().unwrap();
        if deleting {
            if guard.remove(&name).is_some() {
                self.dirty.store(true, Ordering::Relaxed);
            }
            return;
        }

        let expires_at_ms = if let Some(max_age) = parsed.max_age() {
            Some(now_ms().saturating_add((max_age.whole_seconds().max(0) as u64) * 1000))
        } else {
            parsed
                .expires_datetime()
                .map(|t| (t.unix_timestamp().max(0) as u64) * 1000)
        };
        guard.insert(
            name,
            StoredCookie {
                value,
                expires_at_ms,
            },
        );
        self.dirty.store(true, Ordering::Relaxed);
    }
}

impl reqwest::cookie::CookieStore for SessionCookieJar {
    fn set_cookies(&self, cookie_headers: &mut dyn Iterator<Item = &HeaderValue>, url: &Url) {
        if !self.url_in_scope(url) {
            return;
        }
        for header in cookie_headers {
            if let Ok(s) = header.to_str() {
                self.apply_set_cookie(s);
            }
        }
    }

    fn cookies(&self, url: &Url) -> Option<HeaderValue> {
        if !self.url_in_scope(url) {
            return None;
        }
        let now = now_ms();
        let guard = self.cookies.lock().unwrap();
        let joined = guard
            .iter()
            .filter(|(_, v)| !v.is_expired(now))
            .map(|(name, v)| format!("{}={}", name, v.value))
            .collect::<Vec<_>>()
            .join("; ");
        if joined.is_empty() {
            None
        } else {
            HeaderValue::from_str(&joined).ok()
        }
    }
}

/// Identity returned by `GET /api/auth/me` (upstream flat shape).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthIdentity {
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub expires_at: Option<serde_json::Value>,
}

/// A live cookie-authenticated session against one gated dashboard.
pub struct OauthSession {
    base_url: String,
    jar: Arc<SessionCookieJar>,
    client: reqwest::Client,
}

impl OauthSession {
    fn new(base_url: &str) -> Result<Self, AppError> {
        let url = Url::parse(base_url).map_err(|e| {
            AppError::InvalidRequest(format!("invalid dashboard url {base_url}: {e}"))
        })?;
        let jar = Arc::new(SessionCookieJar::new(&url));
        let client = reqwest::Client::builder()
            .cookie_provider(jar.clone())
            // A gated dashboard answers unauthenticated requests with 401 JSON;
            // a misconfigured one might 302 → /login. Never silently follow a
            // redirect to a login page (and drop auth on cross-host hops).
            .redirect(reqwest::redirect::Policy::none())
            .timeout(SESSION_HTTP_TIMEOUT)
            .build()
            .map_err(|e| AppError::Internal(format!("build session http client: {e}")))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            jar,
            client,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The cookie-aware client for REST proxying. Callers add no auth headers.
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn import_cookies(&self, cookies: &[PersistedCookie]) {
        self.jar.import(cookies);
    }

    pub fn export_cookies(&self) -> Vec<PersistedCookie> {
        self.jar.export()
    }

    /// True if the jar holds a live access- or refresh-token cookie. Mirrors
    /// the official `hasLiveOauthSession` (AT ∨ RT) — the AT may have expired
    /// out of the jar while the RT is still good and will rotate a fresh AT.
    pub fn has_live_session(&self) -> bool {
        self.jar.has_variant(&AT_COOKIE_VARIANTS) || self.jar.has_variant(&RT_COOKIE_VARIANTS)
    }

    /// Consume-and-clear the dirty flag (a response captured a rotated cookie).
    pub fn take_dirty(&self) -> bool {
        self.jar.take_dirty()
    }

    pub fn clear(&self) {
        self.jar.clear();
    }

    /// Mint a single-use 30s WebSocket ticket (cookie-authenticated). A 401
    /// means the session is dead → the authoritative liveness signal.
    pub async fn mint_ws_ticket(&self) -> Result<String, AppError> {
        let url = format!("{}/api/auth/ws-ticket", self.base_url);
        let resp = self
            .client
            .post(&url)
            .send()
            .await
            .map_err(|e| AppError::GatewayWs(format!("mint ws ticket: {e}")))?;
        if resp.status().as_u16() == 401 {
            return Err(AppError::AuthSessionExpired(
                "remote session expired while minting a WebSocket ticket".to_string(),
            ));
        }
        if !resp.status().is_success() {
            return Err(AppError::GatewayWs(format!(
                "ws-ticket endpoint returned HTTP {}",
                resp.status().as_u16()
            )));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::GatewayWs(format!("parse ws ticket: {e}")))?;
        body.get("ticket")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::GatewayWs("ws-ticket response missing 'ticket'".to_string()))
    }

    /// Fetch the logged-in identity. 401 ⇒ not authenticated.
    pub async fn fetch_me(&self) -> Result<AuthIdentity, AppError> {
        let url = format!("{}/api/auth/me", self.base_url);
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::DashboardProbe(format!("fetch auth/me: {e}")))?;
        if resp.status().as_u16() == 401 {
            return Err(AppError::AuthSessionExpired(
                "not authenticated".to_string(),
            ));
        }
        if !resp.status().is_success() {
            return Err(AppError::DashboardProbe(format!(
                "auth/me returned HTTP {}",
                resp.status().as_u16()
            )));
        }
        resp.json::<AuthIdentity>()
            .await
            .map_err(|e| AppError::DashboardProbe(format!("parse auth/me: {e}")))
    }
}

/// Process-wide registry of live sessions, keyed by normalized base URL.
/// Login happens (in Settings) before `apply_remote` swaps the AppState, so
/// the session must outlive any single connection and be reachable by URL.
static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<OauthSession>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Arc<OauthSession>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_key(base_url: &str) -> String {
    base_url.trim_end_matches('/').to_string()
}

/// Get (or create) the session for a dashboard URL.
pub fn session_for(base_url: &str) -> Result<Arc<OauthSession>, AppError> {
    let key = normalize_key(base_url);
    let mut guard = registry().lock().unwrap();
    if let Some(existing) = guard.get(&key) {
        return Ok(existing.clone());
    }
    let session = Arc::new(OauthSession::new(base_url)?);
    guard.insert(key, session.clone());
    Ok(session)
}

/// Drop the cached session for a URL (logout / URL change).
pub fn drop_session(base_url: &str) {
    registry().lock().unwrap().remove(&normalize_key(base_url));
}

/// Persist a session's current cookies back into connection.json, but only if
/// it is the active oauth remote for this URL. Called after a request captured
/// a rotated AT/RT — failing to persist a rotated RT would revoke the session.
pub fn persist_if_dirty(base_url: &str, session: &OauthSession) {
    let mut config = crate::connection::read_config();
    let matches = config.mode == crate::connection::ConnectionMode::Remote
        && config.remote_auth_mode == crate::connection::RemoteAuthMode::Oauth
        && config
            .remote_url
            .as_deref()
            .map(|u| normalize_key(u) == normalize_key(base_url))
            .unwrap_or(false);
    if !matches {
        return;
    }
    config.remote_session = Some(session.export_cookies());
    if let Err(err) = crate::connection::write_config(&config) {
        log::warn!("failed to persist rotated oauth session: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::cookie::CookieStore;

    fn jar(base: &str) -> SessionCookieJar {
        SessionCookieJar::new(&Url::parse(base).unwrap())
    }

    fn set(jar: &SessionCookieJar, url: &str, header: &str) {
        let hv = HeaderValue::from_str(header).unwrap();
        let mut it = std::iter::once(&hv);
        jar.set_cookies(&mut it, &Url::parse(url).unwrap());
    }

    #[test]
    fn captures_and_serves_cookie_in_scope() {
        let j = jar("https://gw.example.com");
        set(
            &j,
            "https://gw.example.com/api/x",
            "hermes_session_at=AAA; Path=/",
        );
        assert!(j.take_dirty(), "capturing a cookie flags dirty");
        let hv = j.cookies(&Url::parse("https://gw.example.com/api/y").unwrap());
        assert_eq!(hv.unwrap().to_str().unwrap(), "hermes_session_at=AAA");
    }

    #[test]
    fn out_of_scope_origin_is_ignored() {
        let j = jar("https://gw.example.com");
        set(&j, "https://evil.example.net/x", "hermes_session_rt=BBB");
        assert!(!j.take_dirty());
        assert!(j
            .cookies(&Url::parse("https://evil.example.net/y").unwrap())
            .is_none());
    }

    #[test]
    fn rotation_updates_value_and_flags_dirty() {
        let j = jar("https://gw.example.com");
        set(
            &j,
            "https://gw.example.com/",
            "hermes_session_at=OLD; Path=/",
        );
        j.take_dirty();
        set(
            &j,
            "https://gw.example.com/",
            "hermes_session_at=NEW; Path=/",
        );
        assert!(j.take_dirty(), "rotation is a change");
        let hv = j.cookies(&Url::parse("https://gw.example.com/").unwrap());
        assert_eq!(hv.unwrap().to_str().unwrap(), "hermes_session_at=NEW");
    }

    #[test]
    fn max_age_zero_deletes() {
        let j = jar("https://gw.example.com");
        set(&j, "https://gw.example.com/", "hermes_session_at=AAA");
        set(
            &j,
            "https://gw.example.com/",
            "hermes_session_at=; Max-Age=0",
        );
        assert!(j
            .cookies(&Url::parse("https://gw.example.com/").unwrap())
            .is_none());
    }

    #[test]
    fn import_export_roundtrip_drops_expired() {
        let j = jar("https://gw.example.com");
        j.import(&[
            PersistedCookie {
                name: "hermes_session_rt".into(),
                value: "LIVE".into(),
                expires_at_ms: Some(now_ms() + 60_000),
            },
            PersistedCookie {
                name: "hermes_session_at".into(),
                value: "DEAD".into(),
                expires_at_ms: Some(now_ms().saturating_sub(1000)),
            },
        ]);
        let out = j.export();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "hermes_session_rt");
        assert!(!j.take_dirty(), "import must not flag dirty");
    }

    #[test]
    fn has_variant_detects_at_and_rt() {
        let j = jar("https://gw.example.com");
        assert!(!j.has_variant(&AT_COOKIE_VARIANTS));
        set(
            &j,
            "https://gw.example.com/",
            "__Host-hermes_session_rt=R; Path=/",
        );
        assert!(j.has_variant(&RT_COOKIE_VARIANTS));
        assert!(!j.has_variant(&AT_COOKIE_VARIANTS));
    }

    #[test]
    fn session_registry_is_stable_per_url() {
        let a = session_for("https://reg.example.com/").unwrap();
        let b = session_for("https://reg.example.com").unwrap();
        assert!(Arc::ptr_eq(&a, &b), "same URL yields the same session");
        drop_session("https://reg.example.com");
        let c = session_for("https://reg.example.com").unwrap();
        assert!(!Arc::ptr_eq(&a, &c), "dropped session is rebuilt fresh");
    }
}
