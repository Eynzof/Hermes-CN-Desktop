//! Browser automation commands.
//!
//! Minimal first cut: CDP port probing, Chrome debug launch, and stubbed
//! sidecar commands that the TS `@hermes/browser` handlers invoke. The sidecar
//! lifecycle and Playwright/CDP I/O will be fleshed out in follow-up milestones.

use std::collections::HashMap;
use std::net::{Ipv4Addr, TcpListener};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Shared request client
// ---------------------------------------------------------------------------

fn http_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::Internal(format!("browser http client: {e}")))
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpProbeResult {
    pub ok: bool,
    pub version: Option<String>,
    pub browser: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeLaunchResult {
    pub ok: bool,
    pub cdp_url: String,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSidecarStartInput {
    pub task_id: String,
    pub engine: Option<String>,
    pub headed: Option<bool>,
    pub record_sessions: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSidecarStartResult {
    pub ok: bool,
    pub cdp_url: Option<String>,
    pub session_name: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSidecarStopInput {
    pub task_id: String,
    pub emergency: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSidecarStopResult {
    pub ok: bool,
    pub stopped: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEventPayload {
    pub event: String,
    pub task_id: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserToolResult {
    pub success: bool,
    pub error: Option<String>,
    pub snapshot: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub console: Option<Vec<serde_json::Value>>,
    pub pending_dialogs: Option<Vec<serde_json::Value>>,
}

// ---------------------------------------------------------------------------
// CDP probe
// ---------------------------------------------------------------------------

fn parse_host_port(host_port: &str) -> Result<(String, u16), AppError> {
    let parts: Vec<&str> = host_port.split(':').collect();
    if parts.len() != 2 {
        return Err(AppError::InvalidRequest(format!(
            "expected host:port, got {host_port}"
        )));
    }
    let host = parts[0].to_string();
    let port: u16 = parts[1]
        .parse()
        .map_err(|_| AppError::InvalidRequest(format!("invalid port in {host_port}")))?;
    Ok((host, port))
}

fn is_loopback(host: &str) -> bool {
    host.to_lowercase() == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
}

/// Probe a host:port for a Chrome DevTools Protocol endpoint.
#[tauri::command]
pub async fn browser_cdp_probe(host_port: String) -> Result<CdpProbeResult, AppError> {
    let (host, port) = parse_host_port(&host_port)?;
    if !is_loopback(&host) {
        return Ok(CdpProbeResult {
            ok: false,
            version: None,
            browser: None,
            error: Some(format!("refusing to probe non-loopback host: {host}")),
        });
    }

    let url = format!("http://{host}:{port}/json/version");
    let client = http_client()?;
    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => {
            let body: serde_json::Value = response
                .json()
                .await
                .unwrap_or_else(|_| serde_json::json!({}));
            Ok(CdpProbeResult {
                ok: true,
                version: body["Browser"].as_str().map(String::from),
                browser: body["Protocol-Version"].as_str().map(String::from),
                error: None,
            })
        }
        Ok(response) => Ok(CdpProbeResult {
            ok: false,
            version: None,
            browser: None,
            error: Some(format!("HTTP {}", response.status())),
        }),
        Err(e) => Ok(CdpProbeResult {
            ok: false,
            version: None,
            browser: None,
            error: Some(e.to_string()),
        }),
    }
}

/// Find a free loopback TCP port for Chrome remote debugging.
#[tauri::command]
pub fn browser_find_free_port() -> Result<u16, AppError> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| AppError::Internal(format!("无法绑定本机端口: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Internal(format!("无法读取端口: {e}")))?
        .port();
    Ok(port)
}

// ---------------------------------------------------------------------------
// Chrome launch
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeLaunchInput {
    pub executable: Option<String>,
    pub port: Option<u16>,
    pub user_data_dir: Option<String>,
    pub headed: Option<bool>,
}

fn find_chrome_executable() -> Option<String> {
    #[cfg(target_os = "windows")]
    let candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ];
    #[cfg(target_os = "macos")]
    let candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    #[cfg(target_os = "linux")]
    let candidates = [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
    ];
    for path in candidates {
        if std::path::Path::new(path).is_file() {
            return Some(path.to_string());
        }
    }
    None
}

/// Launch a Chrome-family browser with a remote debugging port.
#[tauri::command]
pub async fn browser_launch_chrome_debug(
    input: ChromeLaunchInput,
) -> Result<ChromeLaunchResult, AppError> {
    let executable = input
        .executable
        .or_else(find_chrome_executable)
        .ok_or_else(|| AppError::Internal("未找到 Chrome/Chromium/Edge 可执行文件".to_string()))?;

    let port = input.port.unwrap_or_else(|| {
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .ok()
            .and_then(|l| l.local_addr().ok().map(|a| a.port()))
            .unwrap_or(9222)
    });

    let user_data_dir = input.user_data_dir.unwrap_or_else(|| {
        dirs::cache_dir()
            .map(|p| p.join("hermes").join("chrome-debug").to_string_lossy().to_string())
            .unwrap_or_else(|| std::env::temp_dir().join("hermes-chrome-debug").to_string_lossy().to_string())
    });

    let mut args = vec![
        format!("--remote-debugging-port={port}"),
        format!("--user-data-dir={user_data_dir}"),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
    ];
    if !input.headed.unwrap_or(false) {
        args.push("--headless=new".to_string());
    }
    args.push("about:blank".to_string());

    let mut child = std::process::Command::new(&executable)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AppError::Internal(format!("无法启动浏览器: {e}")))?;

    let pid = child.id();
    let cdp_url = format!("http://127.0.0.1:{port}");

    // Detach child so it keeps running after command returns.
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok(ChromeLaunchResult {
        ok: true,
        cdp_url,
        pid: Some(pid),
        error: None,
    })
}

// ---------------------------------------------------------------------------
// Sidecar lifecycle (stubs)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn browser_sidecar_start(
    _state: tauri::State<'_, AppState>,
    input: BrowserSidecarStartInput,
) -> Result<BrowserSidecarStartResult, AppError> {
    // M0 stub: report a synthetic loopback CDP endpoint until the Node sidecar
    // is bundled and spawned by Rust.
    let port = browser_find_free_port()?;
    Ok(BrowserSidecarStartResult {
        ok: true,
        cdp_url: Some(format!("http://127.0.0.1:{port}")),
        session_name: format!("sidecar-{}", input.task_id),
        error: None,
    })
}

#[tauri::command]
pub async fn browser_sidecar_stop(
    _state: tauri::State<'_, AppState>,
    input: BrowserSidecarStopInput,
) -> Result<BrowserSidecarStopResult, AppError> {
    Ok(BrowserSidecarStopResult {
        ok: true,
        stopped: input.emergency.unwrap_or(false) || !input.task_id.is_empty(),
        error: None,
    })
}

#[tauri::command]
pub async fn browser_event_subscribe(
    _state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<HashMap<String, serde_json::Value>, AppError> {
    let mut payload = HashMap::new();
    payload.insert("subscribed".to_string(), serde_json::Value::String(task_id));
    Ok(payload)
}

// ---------------------------------------------------------------------------
// Browser tool surface (stubs routed through the sidecar)
// ---------------------------------------------------------------------------

fn not_implemented(method: &str) -> BrowserToolResult {
    BrowserToolResult {
        success: false,
        error: Some(format!("{method} not yet implemented in Rust sidecar")),
        snapshot: None,
        url: None,
        title: None,
        console: None,
        pending_dialogs: None,
    }
}

#[tauri::command]
pub async fn browser_navigate(
    _state: tauri::State<'_, AppState>,
    task_id: String,
    url: String,
    timeout: Option<u64>,
) -> Result<BrowserToolResult, AppError> {
    let _ = (task_id, url, timeout);
    Ok(not_implemented("browser_navigate"))
}

#[tauri::command]
pub async fn browser_snapshot(
    _state: tauri::State<'_, AppState>,
    task_id: String,
    full: Option<bool>,
) -> Result<BrowserToolResult, AppError> {
    let _ = (task_id, full);
    Ok(not_implemented("browser_snapshot"))
}

#[tauri::command]
pub async fn browser_click(
    _state: tauri::State<'_, AppState>,
    task_id: String,
    ref_: String,
) -> Result<BrowserToolResult, AppError> {
    let _ = (task_id, ref_);
    Ok(not_implemented("browser_click"))
}

#[tauri::command]
pub async fn browser_type(
    _state: tauri::State<'_, AppState>,
    task_id: String,
    ref_: String,
    text: String,
    submit: Option<bool>,
) -> Result<BrowserToolResult, AppError> {
    let _ = (task_id, ref_, text, submit);
    Ok(not_implemented("browser_type"))
}

#[tauri::command]
pub async fn browser_scroll(
    _state: tauri::State<'_, AppState>,
    task_id: String,
    direction: String,
    amount: Option<u64>,
) -> Result<BrowserToolResult, AppError> {
    let _ = (task_id, direction, amount);
    Ok(not_implemented("browser_scroll"))
}

#[tauri::command]
pub async fn browser_back(_state: tauri::State<'_, AppState>, task_id: String) -> Result<BrowserToolResult, AppError> {
    let _ = task_id;
    Ok(not_implemented("browser_back"))
}

#[tauri::command]
pub async fn browser_press(
    _state: tauri::State<'_, AppState>,
    task_id: String,
    key: String,
) -> Result<BrowserToolResult, AppError> {
    let _ = (task_id, key);
    Ok(not_implemented("browser_press"))
}

#[tauri::command]
pub async fn browser_console(
    _state: tauri::State<'_, AppState>,
    task_id: String,
    expression: Option<String>,
    clear: Option<bool>,
) -> Result<BrowserToolResult, AppError> {
    let _ = (task_id, expression, clear);
    Ok(not_implemented("browser_console"))
}

#[tauri::command]
pub async fn browser_get_images(
    _state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<BrowserToolResult, AppError> {
    let _ = task_id;
    Ok(not_implemented("browser_get_images"))
}

#[tauri::command]
pub async fn browser_vision(
    _state: tauri::State<'_, AppState>,
    task_id: String,
    question: String,
    annotate: Option<bool>,
) -> Result<BrowserToolResult, AppError> {
    let _ = (task_id, question, annotate);
    Ok(not_implemented("browser_vision"))
}

#[tauri::command]
pub async fn browser_cdp(
    _state: tauri::State<'_, AppState>,
    task_id: String,
    method: String,
    params: Option<serde_json::Value>,
    target_id: Option<String>,
    frame_id: Option<String>,
) -> Result<BrowserToolResult, AppError> {
    let _ = (task_id, method, params, target_id, frame_id);
    Ok(not_implemented("browser_cdp"))
}

#[tauri::command]
pub async fn browser_dialog(
    _state: tauri::State<'_, AppState>,
    task_id: String,
    action: String,
    prompt_text: Option<String>,
    dialog_id: Option<String>,
) -> Result<BrowserToolResult, AppError> {
    let _ = (task_id, action, prompt_text, dialog_id);
    Ok(not_implemented("browser_dialog"))
}

#[tauri::command]
pub async fn browser_exec(
    _state: tauri::State<'_, AppState>,
    task_id: String,
    code: String,
    session: Option<String>,
    timeout_s: Option<u64>,
) -> Result<BrowserToolResult, AppError> {
    let _ = (task_id, code, session, timeout_s);
    Ok(not_implemented("browser_exec"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn free_port() -> u16 {
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[test]
    fn parse_host_port_accepts_loopback() {
        let (host, port) = parse_host_port("127.0.0.1:9222").unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 9222);
    }

    #[test]
    fn parse_host_port_rejects_missing_port() {
        assert!(parse_host_port("127.0.0.1").is_err());
    }

    #[test]
    fn is_loopback_recognizes_localhost_and_ipv4() {
        assert!(is_loopback("localhost"));
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("::1"));
        assert!(!is_loopback("192.168.1.1"));
    }

    #[tokio::test]
    async fn browser_cdp_probe_rejects_non_loopback() {
        let result = browser_cdp_probe("8.8.8.8:9222".to_string()).await.unwrap();
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("non-loopback"));
    }

    #[tokio::test]
    async fn browser_cdp_probe_handles_missing_listener() {
        let port = free_port();
        let result = browser_cdp_probe(format!("127.0.0.1:{port}")).await.unwrap();
        assert!(!result.ok);
        assert!(result.error.is_some());
    }

    #[tokio::test]
    async fn browser_cdp_probe_reads_json_version() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 256];
            let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await;
            let response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 55\r\n\r\n{\"Browser\":\"Chrome/123.0.0.0\",\"Protocol-Version\":\"1.3\"}";
            let _ = tokio::io::AsyncWriteExt::write_all(&mut stream, response).await;
        });

        // Give the tiny server a moment to accept.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let result = browser_cdp_probe(format!("127.0.0.1:{port}")).await.unwrap();
        assert!(result.ok);
        assert_eq!(result.version.as_deref(), Some("Chrome/123.0.0.0"));
        assert_eq!(result.browser.as_deref(), Some("1.3"));
    }

    #[test]
    fn browser_find_free_port_returns_non_zero() {
        let port = browser_find_free_port().unwrap();
        assert!(port > 0);
    }
}
