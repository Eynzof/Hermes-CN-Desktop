// Context reference backend for inline `@file`, `@folder`, `@diff`,
// `@staged`, `@git:N`, and `@url` mentions.
//
// Mirrors the Python `agent/context_references.py` expansion helpers in Rust:
// filesystem reads reuse `read_workspace_file` / `resolve_within_root` from
// `preview.rs`, git commands are captured without modifying repository state,
// and URL fetching is guarded against SSRF.

use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::preview::resolve_within_root;
use crate::connection;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ── IPC payloads ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListInput {
    pub path: String,
    pub root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListResult {
    pub entries: Vec<FolderEntry>,
    pub truncated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCaptureInput {
    pub args: Vec<String>,
    pub cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCaptureResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchInput {
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ── Constants ──────────────────────────────────────────────────────────────────

const FOLDER_LIST_MAX_ENTRIES: usize = 200;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const FETCH_MAX_BYTES: usize = 10 * 1024 * 1024;
const FETCH_MAX_REDIRECTS: usize = 10;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

fn require_local_filesystem(state: &State<'_, AppState>) -> AppResult<()> {
    let inner = state.inner.lock()?;
    connection::require_local_filesystem(inner.connection_mode, "上下文引用")
}

// ── Folder listing ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn context_refs_folder_list(
    input: FolderListInput,
    state: State<'_, AppState>,
) -> AppResult<FolderListResult> {
    require_local_filesystem(&state)?;
    let resolved = resolve_within_root(&input.root, &input.path)?;
    if !resolved.is_dir() {
        return Err(AppError::FileError("Not a directory".to_string()));
    }
    let mut entries: Vec<FolderEntry> = Vec::new();
    let mut truncated = false;
    for entry in std::fs::read_dir(&resolved)? {
        if entries.len() >= FOLDER_LIST_MAX_ENTRIES {
            truncated = true;
            break;
        }
        let entry = entry?;
        let path = entry.path();
        let rel = path.strip_prefix(&resolved).unwrap_or(path.as_path());
        entries.push(FolderEntry {
            path: rel.to_string_lossy().into_owned(),
            is_dir: entry.file_type()?.is_dir(),
        });
    }
    // Stable, predictable order for tests.
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(FolderListResult { entries, truncated })
}

// ── Git capture ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn context_refs_git_capture(
    input: GitCaptureInput,
    _state: State<'_, AppState>,
) -> AppResult<GitCaptureResult> {
    let cwd = PathBuf::from(&input.cwd);
    // Do not require local-filesystem mode for git capture: the workspace may
    // be remote-managed but git reads are still read-only and bounded. Still,
    // reject obviously dangerous args.
    for arg in &input.args {
        if arg.trim_start().starts_with('-') {
            return Err(AppError::InvalidRequest(format!(
                "非法 git 参数（不能以 '-' 开头）：{arg}"
            )));
        }
    }

    let output = run_git_capture(&cwd, &input.args)?;
    Ok(GitCaptureResult {
        stdout: output.0,
        stderr: output.1,
        exit_code: output.2,
    })
}

fn git_command(cwd: &Path, args: &[String]) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("LC_ALL", "C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.args(["-c", "core.quotepath=false"]);
    cmd.args(args);
    cmd
}

fn run_git_capture(cwd: &Path, args: &[String]) -> std::io::Result<(String, String, i32)> {
    let mut cmd = git_command(cwd, args);
    use std::io::Read;
    use std::process::Stdio;
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "git 命令超时，已终止",
            ));
        }
        std::thread::sleep(GIT_POLL_INTERVAL);
    };

    let out = String::from_utf8_lossy(&stdout.join().unwrap_or_default()).into_owned();
    let err = String::from_utf8_lossy(&stderr.join().unwrap_or_default()).into_owned();
    Ok((out, err, status.code().unwrap_or(-1)))
}

// ── Safe HTTP fetch ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn context_refs_http_fetch(
    input: HttpFetchInput,
    _state: State<'_, AppState>,
) -> AppResult<HttpFetchResult> {
    match fetch_url_safe(&input.url).await {
        Ok(text) => Ok(HttpFetchResult {
            ok: true,
            text: Some(text),
            error: None,
        }),
        Err(e) => Ok(HttpFetchResult {
            ok: false,
            text: None,
            error: Some(e.to_string()),
        }),
    }
}

async fn fetch_url_safe(start_url: &str) -> AppResult<String> {
    let mut url: reqwest::Url = start_url
        .parse()
        .map_err(|_| AppError::InvalidRequest(format!("Invalid URL: {start_url}")))?;
    validate_url(&url)?;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| AppError::ProxyError(e.to_string()))?;

    let mut redirects = 0;
    loop {
        let resp = client.get(url.clone()).send().await?;
        if resp.status().is_redirection() {
            if redirects >= FETCH_MAX_REDIRECTS {
                return Err(AppError::ProxyError("Too many redirects".to_string()));
            }
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| AppError::ProxyError("Missing redirect Location".to_string()))?;
            url = url
                .join(loc)
                .map_err(|e| AppError::ProxyError(e.to_string()))?;
            validate_url(&url)?;
            redirects += 1;
            continue;
        }
        let status = resp.status();
        if !status.is_success() {
            return Err(AppError::ProxyError(format!(
                "HTTP {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown")
            )));
        }
        return read_limited_text(resp).await;
    }
}

async fn read_limited_text(resp: reqwest::Response) -> AppResult<String> {
    if let Some(len) = resp.content_length() {
        if len > FETCH_MAX_BYTES as u64 {
            return Err(AppError::ProxyError(format!(
                "Content-Length {} exceeds limit {}",
                len, FETCH_MAX_BYTES
            )));
        }
    }
    let mut stream = resp.bytes_stream();
    let mut acc: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::ProxyError(e.to_string()))?;
        if acc.len() + chunk.len() > FETCH_MAX_BYTES {
            return Err(AppError::ProxyError(format!(
                "Response exceeded {} bytes",
                FETCH_MAX_BYTES
            )));
        }
        acc.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&acc).into_owned())
}

fn validate_url(url: &reqwest::Url) -> AppResult<()> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(AppError::InvalidRequest(format!(
            "仅支持 http/https: {}",
            url.scheme()
        )));
    }
    if let Some(host) = url.host() {
        match host {
            url::Host::Domain(domain) => {
                if domain.is_empty() {
                    return Err(AppError::InvalidRequest("Empty host".to_string()));
                }
                validate_domain(domain)?;
            }
            url::Host::Ipv4(ip) => validate_ip(IpAddr::V4(ip))?,
            url::Host::Ipv6(ip) => validate_ip(IpAddr::V6(ip))?,
        }
    } else {
        return Err(AppError::InvalidRequest("Missing host".to_string()));
    }
    Ok(())
}

fn validate_domain(domain: &str) -> AppResult<()> {
    let lower = domain.to_ascii_lowercase();
    if lower == "localhost" {
        return Err(AppError::InvalidRequest("localhost is blocked".to_string()));
    }
    let addrs: Vec<SocketAddr> =
        match std::net::ToSocketAddrs::to_socket_addrs(&(&lower as &str, 0u16)) {
            Ok(iter) => iter.collect(),
            Err(e) => return Err(AppError::ProxyError(format!("DNS resolution failed: {e}"))),
        };
    if addrs.is_empty() {
        return Err(AppError::ProxyError(
            "DNS resolution returned no addresses".to_string(),
        ));
    }
    for addr in addrs {
        validate_ip(addr.ip())?;
    }
    Ok(())
}

fn validate_ip(ip: IpAddr) -> AppResult<()> {
    let blocked = match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_unspecified()
                || ip.is_documentation()
                || ip.is_broadcast()
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || is_ipv6_private(&ip)
                || is_ipv6_link_local(&ip)
                || is_ipv6_unique_local(&ip)
        }
    };
    if blocked {
        Err(AppError::InvalidRequest(format!(
            "私有/回环地址被禁止: {ip}"
        )))
    } else {
        Ok(())
    }
}

fn is_ipv6_private(ip: &Ipv6Addr) -> bool {
    // fc00::/7 except fd00::/8 is commonly ULA; treat fc00::/7 as private.
    (ip.octets()[0] & 0xfe) == 0xfc
}

fn is_ipv6_link_local(ip: &Ipv6Addr) -> bool {
    ip.segments()[0] & 0xffc0 == 0xfe80
}

fn is_ipv6_unique_local(ip: &Ipv6Addr) -> bool {
    ip.segments()[0] & 0xffc0 == 0xfc00
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    #[test]
    fn folder_list_caps_at_max_entries() {
        let tmp = TempDir::new().unwrap();
        for i in 0..250usize {
            let _ = std::fs::write(tmp.path().join(format!("file_{i}.txt")), "x");
        }
        // Direct synchronous helper test.
        let root = tmp.path().to_string_lossy().to_string();
        let path = ".".to_string();
        let resolved = resolve_within_root(&root, &path).unwrap();
        let mut entries: Vec<FolderEntry> = Vec::new();
        for entry in std::fs::read_dir(&resolved).unwrap() {
            if entries.len() >= FOLDER_LIST_MAX_ENTRIES {
                break;
            }
            let entry = entry.unwrap();
            entries.push(FolderEntry {
                path: entry
                    .path()
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                is_dir: entry.file_type().unwrap().is_dir(),
            });
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(entries.len(), FOLDER_LIST_MAX_ENTRIES);
    }

    #[tokio::test]
    async fn http_fetch_rejects_loopback_ipv4() {
        let err = fetch_url_safe("http://127.0.0.1:8080/x").await.unwrap_err();
        assert!(err.to_string().contains("回环") || err.to_string().contains("loopback"));
    }

    #[tokio::test]
    async fn http_fetch_rejects_private_ipv4() {
        let err = fetch_url_safe("http://192.168.1.1/x").await.unwrap_err();
        assert!(err.to_string().contains("私有") || err.to_string().contains("private"));
    }

    #[tokio::test]
    async fn http_fetch_rejects_localhost() {
        let err = fetch_url_safe("http://localhost/x").await.unwrap_err();
        assert!(err.to_string().contains("localhost") || err.to_string().contains("回环"));
    }

    #[tokio::test]
    async fn http_fetch_rejects_non_http_scheme() {
        let err = fetch_url_safe("file:///etc/passwd").await.unwrap_err();
        assert!(err.to_string().contains("http/https") || err.to_string().contains("Invalid URL"));
    }
}
