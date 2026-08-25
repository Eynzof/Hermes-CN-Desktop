//! Browser automation commands.
//!
//! CDP port probing, Chrome debug launch, a real CDP accessibility-tree
//! snapshot pipeline (`browser_snapshot`), and the remaining sidecar tool
//! surface that is still stubbed and routed through the Node sidecar in
//! follow-up milestones.

use std::collections::HashMap;
use std::net::{Ipv4Addr, TcpListener};
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::browser::snapshot::{prepare_snapshot, AccessibilityNode};
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
    host.to_lowercase() == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
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
    state: tauri::State<'_, AppState>,
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
            .map(|p| {
                p.join("hermes")
                    .join("chrome-debug")
                    .to_string_lossy()
                    .to_string()
            })
            .unwrap_or_else(|| {
                std::env::temp_dir()
                    .join("hermes-chrome-debug")
                    .to_string_lossy()
                    .to_string()
            })
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

    // Record the default browser session so `browser_snapshot` can find the
    // CDP endpoint. The lock is dropped before spawning the detach thread.
    state
        .inner
        .lock()
        .unwrap()
        .browser_sessions
        .insert("default".to_string(), cdp_url.clone());

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
    state: tauri::State<'_, AppState>,
    input: BrowserSidecarStartInput,
) -> Result<BrowserSidecarStartResult, AppError> {
    // M0 stub: report a synthetic loopback CDP endpoint until the Node sidecar
    // is bundled and spawned by Rust. The synthetic URL is still recorded so
    // `browser_snapshot` exercises the real CDP path when a page target exists.
    let port = browser_find_free_port()?;
    let cdp_url = format!("http://127.0.0.1:{port}");
    if !input.task_id.is_empty() {
        state
            .inner
            .lock()
            .unwrap()
            .browser_sessions
            .insert(input.task_id.clone(), cdp_url.clone());
    }
    Ok(BrowserSidecarStartResult {
        ok: true,
        cdp_url: Some(cdp_url),
        session_name: format!("sidecar-{}", input.task_id),
        error: None,
    })
}

#[tauri::command]
pub async fn browser_sidecar_stop(
    state: tauri::State<'_, AppState>,
    input: BrowserSidecarStopInput,
) -> Result<BrowserSidecarStopResult, AppError> {
    state
        .inner
        .lock()
        .unwrap()
        .browser_sessions
        .remove(&input.task_id);
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
    let _ = task_id;
    // SSRF guard at the IPC boundary. `assert_safe_url` performs the TS-compatible
    // sync shape check (http/https, private/loopback blocked by default) and
    // `validate_navigate_url` closes the DNS-rebinding gap by resolving domain
    // hosts and rejecting any that resolve to blocked (private/link-local) IPs.
    let empty_hosts: &[String] = &[];
    let opts = crate::security::url::SsrfOptions {
        allow_private_urls: false,
        allowed_hosts: empty_hosts,
    };
    let safe_url = crate::security::url::assert_safe_url(&url, &opts)?;
    crate::security::url::validate_navigate_url(&safe_url).await?;
    let _ = (timeout, safe_url);
    Ok(not_implemented("browser_navigate"))
}

/// Thin wrapper for TS parity tooling / tests: returns the SSRF evaluation
/// result without rejecting. Not required for the production flow.
#[tauri::command]
pub async fn browser_url_safety_check(
    url: String,
    allow_private_urls: Option<bool>,
    allowed_hosts: Option<Vec<String>>,
) -> Result<crate::security::url::UrlSafetyResult, AppError> {
    let allowed_hosts: &[String] = allowed_hosts.as_deref().unwrap_or(&[]);
    let opts = crate::security::url::SsrfOptions {
        allow_private_urls: allow_private_urls.unwrap_or(false),
        allowed_hosts,
    };
    Ok(crate::security::url::evaluate_url_safety(&url, &opts))
}

/// Default snapshot character budget before truncation.
const SNAPSHOT_DEFAULT_MAX_CHARS: usize = 15_000;
/// Snapshot budget used when the caller requests a full (`full: true`) snapshot.
const SNAPSHOT_FULL_MAX_CHARS: usize = 1_000_000;
/// Upper bound for a single CDP snapshot round-trip.
const CDP_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(15);

/// Extract `{key: {value: "..."}}` from a CDP AX node.
fn cdp_ax_value(node: &serde_json::Value, key: &str) -> Option<String> {
    node.get(key)
        .and_then(|v| v.get("value"))
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// Build an [`AccessibilityNode`] tree from a raw CDP `Accessibility.getFullAXTree`
/// `nodes` payload.
///
/// Semantics:
/// - every node must carry a numeric `nodeId`; others are skipped;
/// - `ignored: true` nodes are dropped together with their subtree;
/// - `role` / `name` / `value` come from the `{value: string}` wrappers;
/// - children are attached through `childIds`;
/// - the root is the node whose id is never referenced by any `childIds`; when
///   several roots exist they are wrapped in a synthetic `WebArea` node.
pub fn build_ax_tree(nodes: &[serde_json::Value]) -> AccessibilityNode {
    struct RawNode {
        node_id: i64,
        ignored: bool,
        role: Option<String>,
        name: Option<String>,
        value: Option<String>,
        child_ids: Vec<i64>,
    }

    let mut raw: Vec<RawNode> = Vec::new();
    let mut parent_of: HashMap<i64, i64> = HashMap::new();
    let mut id_to_index: HashMap<i64, usize> = HashMap::new();

    for (idx, node) in nodes.iter().enumerate() {
        let Some(node_id) = node.get("nodeId").and_then(|v| v.as_i64()) else {
            continue;
        };
        let child_ids: Vec<i64> = node
            .get("childIds")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|c| c.as_i64()).collect())
            .unwrap_or_default();
        for child in &child_ids {
            parent_of.insert(*child, node_id);
        }
        id_to_index.insert(node_id, idx);
        raw.push(RawNode {
            node_id,
            ignored: node
                .get("ignored")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            role: cdp_ax_value(node, "role"),
            name: cdp_ax_value(node, "name"),
            value: cdp_ax_value(node, "value"),
            child_ids,
        });
    }

    fn assemble(
        raw: &[RawNode],
        id_to_index: &HashMap<i64, usize>,
        node_id: i64,
    ) -> Option<AccessibilityNode> {
        let idx = *id_to_index.get(&node_id)?;
        let node = &raw[idx];
        if node.ignored {
            return None;
        }
        let children = node
            .child_ids
            .iter()
            .filter_map(|child| assemble(raw, id_to_index, *child))
            .collect();
        Some(AccessibilityNode {
            role: node.role.clone(),
            name: node.name.clone(),
            value: node.value.clone(),
            children,
            r#ref: None,
        })
    }

    let roots: Vec<i64> = raw
        .iter()
        .filter(|n| !n.ignored && !parent_of.contains_key(&n.node_id))
        .map(|n| n.node_id)
        .collect();

    let mut assembled: Vec<AccessibilityNode> = roots
        .iter()
        .filter_map(|id| assemble(&raw, &id_to_index, *id))
        .collect();

    if assembled.len() == 1 {
        assembled.remove(0)
    } else {
        AccessibilityNode {
            role: Some("WebArea".to_string()),
            name: None,
            value: None,
            children: assembled,
            r#ref: None,
        }
    }
}

/// Discover the first page target's WebSocket debugger URL from `{cdp}/json`.
async fn fetch_page_ws_url(cdp_url: &str) -> Result<String, AppError> {
    let client = http_client()?;
    let url = format!("{cdp_url}/json");
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("CDP /json request failed: {e}")))?;
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("CDP /json parse failed: {e}")))?;
    let targets = body
        .as_array()
        .ok_or_else(|| AppError::Internal("CDP /json did not return an array".to_string()))?;
    for target in targets {
        if target.get("type").and_then(|v| v.as_str()) == Some("page") {
            if let Some(ws) = target.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                return Ok(ws.to_string());
            }
        }
    }
    Err(AppError::Internal(
        "no page target with webSocketDebuggerUrl found".to_string(),
    ))
}

/// Fetch and format an accessibility-tree snapshot over CDP.
async fn cdp_snapshot(cdp_url: &str, full: bool) -> Result<BrowserToolResult, AppError> {
    let ws_url = fetch_page_ws_url(cdp_url).await?;
    tokio::time::timeout(CDP_SNAPSHOT_TIMEOUT, cdp_fetch_snapshot(&ws_url, full))
        .await
        .map_err(|_| AppError::Internal("CDP snapshot timed out after 15s".to_string()))?
}

async fn cdp_fetch_snapshot(ws_url: &str, full: bool) -> Result<BrowserToolResult, AppError> {
    let (mut ws, _) = connect_async(ws_url)
        .await
        .map_err(|e| AppError::Internal(format!("CDP websocket connect failed: {e}")))?;
    ws.send(Message::Text(
        r#"{"id":1,"method":"Accessibility.getFullAXTree","params":{}}"#.into(),
    ))
    .await
    .map_err(|e| AppError::Internal(format!("CDP send failed: {e}")))?;

    let mut nodes: Option<Vec<serde_json::Value>> = None;
    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| AppError::Internal(format!("CDP recv failed: {e}")))?;
        if let Message::Text(text) = msg {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if v.get("id").and_then(|i| i.as_i64()) == Some(1) {
                    if let Some(err) = v.get("error") {
                        return Err(AppError::Internal(format!(
                            "CDP getFullAXTree error: {err}"
                        )));
                    }
                    nodes = v
                        .get("result")
                        .and_then(|r| r.get("nodes"))
                        .and_then(|n| n.as_array())
                        .cloned();
                    break;
                }
            }
        }
    }
    let nodes = nodes
        .ok_or_else(|| AppError::Internal("CDP getFullAXTree returned no nodes".to_string()))?;

    let root = build_ax_tree(&nodes);
    let max_chars = if full {
        SNAPSHOT_FULL_MAX_CHARS
    } else {
        SNAPSHOT_DEFAULT_MAX_CHARS
    };
    let formatted = prepare_snapshot(&root, Some(max_chars), None)
        .map_err(|e| AppError::Internal(format!("snapshot formatting failed: {e}")))?;

    Ok(BrowserToolResult {
        success: true,
        error: None,
        snapshot: Some(formatted.text),
        url: None,
        title: None,
        console: None,
        pending_dialogs: None,
    })
}

#[tauri::command]
pub async fn browser_snapshot(
    state: tauri::State<'_, AppState>,
    task_id: String,
    full: Option<bool>,
) -> Result<BrowserToolResult, AppError> {
    let key = if task_id.is_empty() {
        "default"
    } else {
        task_id.as_str()
    };
    let cdp_url = state
        .inner
        .lock()
        .unwrap()
        .browser_sessions
        .get(key)
        .cloned()
        .ok_or_else(|| {
            AppError::Internal(format!(
                "no browser session for task '{key}' — call browser_sidecar_start or browser_launch_chrome_debug first"
            ))
        })?;
    cdp_snapshot(&cdp_url, full.unwrap_or(false)).await
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
pub async fn browser_back(
    _state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<BrowserToolResult, AppError> {
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
        let result = browser_cdp_probe(format!("127.0.0.1:{port}"))
            .await
            .unwrap();
        assert!(!result.ok);
        assert!(result.error.is_some());
    }

    #[tokio::test]
    async fn browser_cdp_probe_reads_json_version() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
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

        let result = browser_cdp_probe(format!("127.0.0.1:{port}"))
            .await
            .unwrap();
        assert!(result.ok);
        assert_eq!(result.version.as_deref(), Some("Chrome/123.0.0.0"));
        assert_eq!(result.browser.as_deref(), Some("1.3"));
    }

    #[test]
    fn browser_find_free_port_returns_non_zero() {
        let port = browser_find_free_port().unwrap();
        assert!(port > 0);
    }

    #[test]
    fn build_ax_tree_nested_tree_with_ignored_node() {
        let nodes = serde_json::json!([
            { "nodeId": 1, "ignored": false, "role": { "value": "rootWebArea" }, "name": { "value": "Example" }, "childIds": [2, 3] },
            { "nodeId": 2, "ignored": false, "role": { "value": "link" }, "name": { "value": "Home" } },
            { "nodeId": 3, "ignored": true, "role": { "value": "generic" }, "childIds": [4] },
            { "nodeId": 4, "ignored": false, "role": { "value": "button" }, "name": { "value": "Hidden" } }
        ]);
        let tree = build_ax_tree(nodes.as_array().unwrap());
        assert_eq!(tree.role.as_deref(), Some("rootWebArea"));
        assert_eq!(tree.name.as_deref(), Some("Example"));
        // Ignored node 3 and its child 4 are dropped entirely.
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].role.as_deref(), Some("link"));
        assert_eq!(tree.children[0].name.as_deref(), Some("Home"));
    }

    #[test]
    fn build_ax_tree_wraps_multiple_roots_in_web_area() {
        let nodes = serde_json::json!([
            { "nodeId": 1, "role": { "value": "button" }, "name": { "value": "A" } },
            { "nodeId": 2, "role": { "value": "button" }, "name": { "value": "B" } }
        ]);
        let tree = build_ax_tree(nodes.as_array().unwrap());
        assert_eq!(tree.role.as_deref(), Some("WebArea"));
        assert_eq!(tree.children.len(), 2);
    }

    #[test]
    fn build_ax_tree_skips_missing_node_ids() {
        let nodes = serde_json::json!([
            { "role": { "value": "button" } },
            { "nodeId": "not-a-number", "role": { "value": "link" } }
        ]);
        let tree = build_ax_tree(nodes.as_array().unwrap());
        assert_eq!(tree.role.as_deref(), Some("WebArea"));
        assert!(tree.children.is_empty());
    }

    #[test]
    fn cdp_ax_value_reads_wrapper_shape() {
        let node = serde_json::json!({ "role": { "value": "link" }, "name": { "value": "Go" } });
        assert_eq!(cdp_ax_value(&node, "role").as_deref(), Some("link"));
        assert_eq!(cdp_ax_value(&node, "name").as_deref(), Some("Go"));
        assert_eq!(cdp_ax_value(&node, "missing"), None);
    }
}
