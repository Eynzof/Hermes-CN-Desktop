//! MCP stdio process bridge for the in-process TypeScript MCP client.

use std::io::{BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use tauri::Emitter;

use crate::error::AppError;
use crate::schema::mcp::{
    McpStdioDataEvent, McpStdioExitEvent, McpStdioKillArgs, McpStdioSpawnArgs, McpStdioWriteArgs,
};
use crate::state::AppState;

fn generate_child_id() -> Result<String, AppError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| AppError::Internal(format!("random: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

// ---------------------------------------------------------------------------
// MCP OAuth remote servers (P1-10): PKCE helpers + trust gating.
//
// Real loopback/paste-back OAuth lives in the managed runtime; these commands
// provide the desktop-side wire surface: begin (PKCE challenge), apply
// (exchange code → token), and trust gating for remote servers.
// ---------------------------------------------------------------------------

/// PKCE pair for an MCP OAuth flow.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthBeginResult {
    pub state: String,
    pub authorization_url: String,
    /// Base64url code_verifier (no padding) that must be passed to apply.
    pub code_verifier: String,
}

/// PKCE helper: SHA-256(code_verifier) → base64url no-pad (RFC 7636).
pub fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Generate a PKCE verifier + challenge pair.
pub fn generate_pkce_pair() -> Result<(String, String), AppError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| AppError::Internal(format!("random: {e}")))?;
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    Ok((verifier.clone(), pkce_challenge(&verifier)))
}

static MCP_TRUSTED: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// `mcp_oauth_begin` — start a PKCE OAuth flow for a remote MCP server.
#[tauri::command]
pub fn mcp_oauth_begin(
    _server_name: String,
    authorization_url: String,
    client_id: String,
    scopes: Option<String>,
) -> Result<McpOAuthBeginResult, AppError> {
    let (verifier, challenge) = generate_pkce_pair()?;
    let mut state_bytes = [0u8; 16];
    getrandom::fill(&mut state_bytes).map_err(|e| AppError::Internal(format!("random: {e}")))?;
    let state = URL_SAFE_NO_PAD.encode(state_bytes);
    let mut url = format!(
          "{authorization_url}?response_type=code&client_id={}&code_challenge={}&code_challenge_method=S256&state={}",
          urlencoding::encode(&client_id),
          challenge,
          state
      );
    if let Some(scopes) = scopes.filter(|s| !s.is_empty()) {
        url.push_str(&format!("&scope={}", urlencoding::encode(&scopes)));
    }
    Ok(McpOAuthBeginResult {
        state,
        authorization_url: url,
        code_verifier: verifier,
    })
}

/// `mcp_oauth_apply` — exchange the authorization code for a token and mark
/// the server trusted. Returns the access token (desktop keeps it in memory;
/// the managed runtime owns persistence).
#[tauri::command]
pub async fn mcp_oauth_apply(
    server_name: String,
    token_url: String,
    client_id: String,
    code: String,
    code_verifier: String,
) -> Result<serde_json::Value, AppError> {
    let client = reqwest::Client::new();
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id.as_str()),
        ("code", code.as_str()),
        ("code_verifier", code_verifier.as_str()),
    ];
    let response = client
        .post(&token_url)
        .form(&form)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("token request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "token endpoint returned HTTP {}",
            response.status()
        )));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("token response parse failed: {e}")))?;
    MCP_TRUSTED
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))?
        .insert(server_name);
    Ok(body)
}

/// `mcp_server_trust` — set/query the trust gate for a remote MCP server.
#[tauri::command]
pub fn mcp_server_trust(server_name: String, trusted: Option<bool>) -> Result<bool, AppError> {
    let mut set = MCP_TRUSTED
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if let Some(trusted) = trusted {
        if trusted {
            set.insert(server_name.clone());
        } else {
            set.remove(&server_name);
        }
    }
    Ok(set.contains(&server_name))
}

/// Spawn a child process for an MCP stdio server and start forwarding stdout to
/// Tauri events.
#[tauri::command]
pub async fn mcp_stdio_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    args: McpStdioSpawnArgs,
) -> Result<String, AppError> {
    let mut cmd = std::process::Command::new(&args.command);
    cmd.args(&args.args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::piped());
    for (k, v) in &args.env {
        cmd.env(k, v);
    }
    if let Some(cwd) = &args.cwd {
        cmd.current_dir(cwd);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Internal(format!("spawn failed: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("missing stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("missing stderr".into()))?;

    let child_id = generate_child_id()?;
    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = stop.clone();
    let app_clone = app.clone();
    let reader_id = child_id.clone();

    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut line = String::new();
        loop {
            if reader_stop.load(Ordering::Relaxed) {
                break;
            }
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let bytes = line.as_bytes().to_vec();
                    let _ = app_clone.emit(
                        &format!("mcp_stdio_data:{reader_id}"),
                        McpStdioDataEvent {
                            child_id: reader_id.clone(),
                            bytes,
                        },
                    );
                    line.clear();
                }
                Err(_) => break,
            }
        }
        let mut tail = String::new();
        let mut err_reader = std::io::BufReader::new(stderr);
        let _ = err_reader.read_to_string(&mut tail);
        let _ = app_clone.emit(
            &format!("mcp_stdio_exit:{reader_id}"),
            McpStdioExitEvent {
                child_id: reader_id,
                code: None,
                stderr_tail: tail,
            },
        );
    });

    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        inner.mcp_stdio_children.insert(
            child_id.clone(),
            crate::state::McpStdioProcess {
                child: Mutex::new(child),
                stop,
            },
        );
    }

    Ok(child_id)
}

/// Write bytes to the stdin of a spawned MCP child.
#[tauri::command]
pub async fn mcp_stdio_write(
    state: tauri::State<'_, AppState>,
    args: McpStdioWriteArgs,
) -> Result<(), AppError> {
    let inner = state
        .inner
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let proc = inner
        .mcp_stdio_children
        .get(&args.child_id)
        .ok_or_else(|| AppError::Internal(format!("unknown child {}", args.child_id)))?;
    let mut child = proc
        .child
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| AppError::Internal("stdin closed".into()))?;
    stdin
        .write_all(&args.bytes)
        .map_err(|e| AppError::Internal(format!("stdin write: {e}")))?;
    stdin
        .flush()
        .map_err(|e| AppError::Internal(format!("stdin flush: {e}")))?;
    Ok(())
}

/// Kill a spawned MCP child.
#[tauri::command]
pub async fn mcp_stdio_kill(
    state: tauri::State<'_, AppState>,
    args: McpStdioKillArgs,
) -> Result<(), AppError> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let Some(proc) = inner.mcp_stdio_children.remove(&args.child_id) else {
        return Ok(());
    };
    proc.stop.store(true, Ordering::Relaxed);
    let mut child = proc
        .child
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let _ = child.kill();
    Ok(())
}

/// List active MCP stdio child processes.
#[tauri::command]
pub async fn mcp_stdio_status(state: tauri::State<'_, AppState>) -> Result<Vec<String>, AppError> {
    let inner = state
        .inner
        .lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(inner.mcp_stdio_children.keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_shape() {
        // RFC 7636 Appendix B example vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = pkce_challenge(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn generate_pkce_pair_returns_distinct_verifiers() {
        let (v1, c1) = generate_pkce_pair().unwrap();
        let (v2, c2) = generate_pkce_pair().unwrap();
        assert_ne!(v1, v2);
        assert_eq!(c1, pkce_challenge(&v1));
        assert_eq!(c2, pkce_challenge(&v2));
    }

    #[test]
    fn oauth_begin_builds_authorization_url_with_pkce_params() {
        let result = mcp_oauth_begin(
            "remote-mcp".into(),
            "https://auth.example/authorize".into(),
            "client-123".into(),
            Some("read write".into()),
        )
        .unwrap();
        assert!(result
            .authorization_url
            .starts_with("https://auth.example/authorize?"));
        assert!(result.authorization_url.contains("code_challenge="));
        assert!(result
            .authorization_url
            .contains("code_challenge_method=S256"));
        assert!(result.authorization_url.contains("state="));
        assert!(result.authorization_url.contains("scope=read%20write"));
        assert!(!result.code_verifier.is_empty());
    }

    #[test]
    fn trust_gate_defaults_to_false_and_sets() {
        assert!(!mcp_server_trust("srv-a".into(), None).unwrap());
        assert!(mcp_server_trust("srv-a".into(), Some(true)).unwrap());
        assert!(mcp_server_trust("srv-a".into(), None).unwrap());
        assert!(!mcp_server_trust("srv-a".into(), Some(false)).unwrap());
        assert!(!mcp_server_trust("srv-b".into(), None).unwrap());
    }
}
