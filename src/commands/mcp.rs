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
