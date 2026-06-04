use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::process::runtime;
use crate::state::AppState;

const TERMINAL_EVENT: &str = "terminal-output";
const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 30;
const MAX_COLS: u16 = 300;
const MAX_ROWS: u16 = 120;

static TERMINAL_SESSIONS: LazyLock<Mutex<HashMap<String, TerminalSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartInput {
    pub purpose: Option<String>,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub initial_input: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResult {
    pub terminal_id: String,
    pub cwd: String,
    pub shell: String,
    pub profile: String,
    pub hermes_home: String,
    pub managed_runtime: Option<ManagedRuntimeSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeSummary {
    pub runtime_version: String,
    pub executable_path: String,
    pub shim_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteInput {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeInput {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseInput {
    pub terminal_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEventPayload {
    pub terminal_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
struct TerminalContext {
    hermes_home: String,
    hermes_home_base: String,
    profile: String,
    api_base_url: String,
}

#[tauri::command]
pub fn terminal_start(
    app: AppHandle,
    state: State<'_, AppState>,
    input: TerminalStartInput,
) -> Result<TerminalStartResult, String> {
    let context = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        TerminalContext {
            hermes_home: inner.hermes_home.clone(),
            hermes_home_base: inner.hermes_home_base.clone(),
            profile: inner.current_profile.clone(),
            api_base_url: inner.api_base_url.clone(),
        }
    };

    let cols = normalize_size(input.cols, DEFAULT_COLS, MAX_COLS);
    let rows = normalize_size(input.rows, DEFAULT_ROWS, MAX_ROWS);
    let cwd = resolve_cwd(input.cwd.as_deref(), &context)?;
    let shell = default_shell_program();
    let terminal_id = new_terminal_id();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("无法打开终端：{e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("无法读取终端输出：{e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("无法写入终端：{e}"))?;

    let runtime_summary = prepare_managed_runtime_shim().transpose()?;
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    apply_terminal_env(&mut cmd, &context, runtime_summary.as_ref(), &shell);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("无法启动终端 Shell：{e}"))?;
    drop(pair.slave);

    let initial_input = initial_input_for(input.purpose.as_deref(), input.initial_input.as_deref());
    if let Some(data) = initial_input {
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("无法写入初始命令：{e}"))?;
        let _ = writer.flush();
    }

    {
        let mut sessions = TERMINAL_SESSIONS.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            terminal_id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    spawn_reader_thread(app, terminal_id.clone(), reader);

    Ok(TerminalStartResult {
        terminal_id,
        cwd: cwd.to_string_lossy().to_string(),
        shell,
        profile: context.profile,
        hermes_home: context.hermes_home,
        managed_runtime: runtime_summary,
    })
}

#[tauri::command]
pub fn terminal_write(input: TerminalWriteInput) -> Result<bool, String> {
    let mut sessions = TERMINAL_SESSIONS.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&input.terminal_id)
        .ok_or_else(|| "终端会话已结束，请重新打开。".to_string())?;
    session
        .writer
        .write_all(input.data.as_bytes())
        .map_err(|e| format!("写入终端失败：{e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("刷新终端失败：{e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn terminal_resize(input: TerminalResizeInput) -> Result<bool, String> {
    let cols = normalize_size(Some(input.cols), DEFAULT_COLS, MAX_COLS);
    let rows = normalize_size(Some(input.rows), DEFAULT_ROWS, MAX_ROWS);
    let sessions = TERMINAL_SESSIONS.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&input.terminal_id)
        .ok_or_else(|| "终端会话已结束，请重新打开。".to_string())?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整终端大小失败：{e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn terminal_close(input: TerminalCloseInput) -> Result<bool, String> {
    let mut session = {
        let mut sessions = TERMINAL_SESSIONS.lock().map_err(|e| e.to_string())?;
        sessions.remove(&input.terminal_id)
    };

    if let Some(session) = session.as_mut() {
        let _ = session.child.kill();
    }
    Ok(true)
}

fn normalize_size(value: Option<u16>, fallback: u16, max: u16) -> u16 {
    value.unwrap_or(fallback).clamp(10, max)
}

fn default_shell_program() -> String {
    #[cfg(target_os = "windows")]
    {
        env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        env::var("SHELL").unwrap_or_else(|_| {
            if Path::new("/bin/zsh").is_file() {
                "/bin/zsh".to_string()
            } else if Path::new("/bin/bash").is_file() {
                "/bin/bash".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
    }
}

fn resolve_cwd(requested: Option<&str>, context: &TerminalContext) -> Result<PathBuf, String> {
    if let Some(value) = requested.map(str::trim).filter(|v| !v.is_empty()) {
        let path = PathBuf::from(value);
        if path.is_dir() {
            return Ok(path);
        }
        return Err(format!("目录不存在：{value}"));
    }

    let candidates = [
        PathBuf::from(&context.hermes_home),
        PathBuf::from(&context.hermes_home_base),
        runtime::hermes_home_dir(),
    ];

    for path in candidates {
        if path.as_os_str().is_empty() {
            continue;
        }
        if fs::create_dir_all(&path).is_ok() && path.is_dir() {
            return Ok(path);
        }
    }

    dirs::home_dir().ok_or_else(|| "无法确定终端工作目录。".to_string())
}

fn prepare_managed_runtime_shim() -> Option<Result<ManagedRuntimeSummary, String>> {
    let record = runtime::read_current_record()?;
    let executable_path = PathBuf::from(&record.executable_path);
    let shim_dir = runtime::runtime_root().join("desktop-bin");
    Some(
        ensure_hermes_shim(&shim_dir, &executable_path).map(|_| ManagedRuntimeSummary {
            runtime_version: record.runtime_version,
            executable_path: record.executable_path,
            shim_dir: shim_dir.to_string_lossy().to_string(),
        }),
    )
}

fn ensure_hermes_shim(shim_dir: &Path, executable_path: &Path) -> Result<(), String> {
    fs::create_dir_all(shim_dir).map_err(|e| format!("无法创建 Hermes 命令目录：{e}"))?;

    #[cfg(target_os = "windows")]
    {
        let escaped = executable_path.to_string_lossy().replace('"', "\"\"");
        let content = format!("@echo off\r\n\"{}\" %*\r\n", escaped);
        fs::write(shim_dir.join("hermes.cmd"), &content)
            .map_err(|e| format!("无法写入 hermes.cmd：{e}"))?;
        fs::write(shim_dir.join("hermes.bat"), &content)
            .map_err(|e| format!("无法写入 hermes.bat：{e}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = format!(
            "#!/bin/sh\nexec {} \"$@\"\n",
            shell_quote(&executable_path.to_string_lossy())
        );
        let shim = shim_dir.join("hermes");
        fs::write(&shim, script).map_err(|e| format!("无法写入 hermes 命令：{e}"))?;
        let mut perms = fs::metadata(&shim)
            .map_err(|e| format!("无法读取 hermes 命令权限：{e}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&shim, perms).map_err(|e| format!("无法设置 hermes 命令权限：{e}"))?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn apply_terminal_env(
    cmd: &mut CommandBuilder,
    context: &TerminalContext,
    runtime_summary: Option<&ManagedRuntimeSummary>,
    shell: &str,
) {
    for (key, value) in env::vars() {
        if should_forward_env(&key) {
            cmd.env(&key, &value);
        }
    }

    cmd.env(
        "TERM",
        env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string()),
    );
    cmd.env("COLORTERM", "truecolor");
    cmd.env("CLICOLOR", "1");
    cmd.env("CLICOLOR_FORCE", "1");
    cmd.env("FORCE_COLOR", "1");
    cmd.env("TERM_PROGRAM", "Hermes Console");
    cmd.env("LSCOLORS", "GxFxCxDxBxegedabagaced");
    cmd.env("GREP_COLORS", "mt=01;38;5;214:ms=01;38;5;214:mc=01;38;5;214:sl=:cx=:fn=38;5;81:ln=38;5;244:bn=38;5;144:se=38;5;244");
    apply_color_prompt_env(cmd, shell);
    cmd.env("HERMES_DESKTOP_TERMINAL", "1");
    cmd.env("HERMES_HOME", &context.hermes_home);
    cmd.env("HERMES_PROFILE", &context.profile);
    cmd.env(
        "HERMES_DESKTOP_RUNTIME_ROOT",
        runtime::runtime_root().to_string_lossy().to_string(),
    );
    cmd.env(
        "HERMES_GATEWAY_RUNTIME_DIR",
        runtime::gateway_runtime_dir().to_string_lossy().to_string(),
    );
    cmd.env(
        "HERMES_GATEWAY_LOCK_DIR",
        runtime::gateway_runtime_dir()
            .join("token-locks")
            .to_string_lossy()
            .to_string(),
    );
    if !context.api_base_url.is_empty() {
        cmd.env("HERMES_DASHBOARD_URL", &context.api_base_url);
    }
    if let Some(web_dist) = runtime::current_dashboard_web_dist_dir() {
        cmd.env("HERMES_WEB_DIST", web_dist.to_string_lossy().to_string());
    }
    if let Some(skills_dir) = runtime::current_bundled_skills_dir() {
        cmd.env(
            "HERMES_BUNDLED_SKILLS",
            skills_dir.to_string_lossy().to_string(),
        );
    }

    if let Some(summary) = runtime_summary {
        let existing = env::var("PATH").unwrap_or_default();
        cmd.env("PATH", prepend_path(&summary.shim_dir, &existing));
        cmd.env("HERMES_MANAGED_RUNTIME", &summary.executable_path);
    }
}

fn apply_color_prompt_env(cmd: &mut CommandBuilder, shell: &str) {
    let shell_name = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();

    if cfg!(target_os = "windows") {
        cmd.env("PROMPT", "$E[38;5;214m$P$E[0m$G ");
    } else if shell_name.contains("zsh") {
        cmd.env("PROMPT", "%F{244}%n@%m%f %F{214}%1~%f %# ");
    } else if shell_name.contains("fish") {
        cmd.env("fish_color_cwd", "yellow");
        cmd.env("fish_color_command", "cyan");
        cmd.env("fish_color_param", "normal");
    } else {
        cmd.env(
            "PS1",
            "\\[\x1b[38;5;244m\\]\\u@\\h\\[\x1b[0m\\] \\[\x1b[38;5;214m\\]\\W\\[\x1b[0m\\] \\\\$ ",
        );
    }
}

fn should_forward_env(key: &str) -> bool {
    key == "PATH"
        || key == "HOME"
        || key == "USER"
        || key == "USERNAME"
        || key == "LOGNAME"
        || key == "SHELL"
        || key == "LANG"
        || key == "TMPDIR"
        || key == "TEMP"
        || key == "TMP"
        || key == "SystemRoot"
        || key == "USERPROFILE"
        || key == "APPDATA"
        || key == "LOCALAPPDATA"
        || key == "ComSpec"
        || key == "PATHEXT"
        || key.starts_with("LC_")
}

fn prepend_path(dir: &str, existing: &str) -> String {
    let sep = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    if existing.trim().is_empty() {
        dir.to_string()
    } else {
        format!("{dir}{sep}{existing}")
    }
}

fn initial_input_for(purpose: Option<&str>, explicit: Option<&str>) -> Option<String> {
    if let Some(value) = explicit.filter(|v| !v.is_empty()) {
        return Some(value.to_string());
    }

    match purpose {
        Some("gatewaySetup") | Some("gateway_setup") => Some("hermes gateway setup\r".to_string()),
        Some("gatewayStatus") | Some("gateway_status") => {
            Some("hermes gateway status\r".to_string())
        }
        _ => None,
    }
}

fn spawn_reader_thread(app: AppHandle, terminal_id: String, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buf = [0_u8; 8192];
        // Carry buffer for a multi-byte UTF-8 sequence split across reads.
        // Without this, a chunk boundary inside e.g. a Chinese character would
        // be mangled into a `�` replacement char by lossy decoding.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = drain_utf8(&mut pending);
                    if data.is_empty() {
                        // Only an incomplete trailing sequence so far; wait for
                        // the rest before emitting.
                        continue;
                    }
                    emit_terminal_event(
                        &app,
                        TerminalEventPayload {
                            terminal_id: terminal_id.clone(),
                            kind: "data".to_string(),
                            data: Some(data),
                            exit_code: None,
                            message: None,
                        },
                    );
                }
                Err(e) => {
                    emit_terminal_event(
                        &app,
                        TerminalEventPayload {
                            terminal_id: terminal_id.clone(),
                            kind: "error".to_string(),
                            data: None,
                            exit_code: None,
                            message: Some(e.to_string()),
                        },
                    );
                    break;
                }
            }
        }

        // Flush any trailing bytes (e.g. a truncated sequence left when the PTY
        // closed) so the final output isn't silently dropped.
        if !pending.is_empty() {
            emit_terminal_event(
                &app,
                TerminalEventPayload {
                    terminal_id: terminal_id.clone(),
                    kind: "data".to_string(),
                    data: Some(String::from_utf8_lossy(&pending).to_string()),
                    exit_code: None,
                    message: None,
                },
            );
        }

        let exit_code = {
            let mut session = TERMINAL_SESSIONS
                .lock()
                .ok()
                .and_then(|mut sessions| sessions.remove(&terminal_id));
            session
                .as_mut()
                .and_then(|session| session.child.wait().ok())
                .map(|status| status.exit_code() as i32)
        };

        emit_terminal_event(
            &app,
            TerminalEventPayload {
                terminal_id,
                kind: "exit".to_string(),
                data: None,
                exit_code,
                message: None,
            },
        );
    });
}

fn emit_terminal_event(app: &AppHandle, payload: TerminalEventPayload) {
    let _ = app.emit(TERMINAL_EVENT, payload);
}

/// Decode as much valid UTF-8 as possible from `pending`, leaving only an
/// incomplete trailing multi-byte sequence (at most 3 bytes) in the buffer for
/// the next read to complete. Genuinely invalid bytes are replaced with the
/// Unicode replacement character so the stream can't stall.
fn drain_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                out.push_str(valid);
                pending.clear();
                return out;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                // Bytes before `valid_up_to` are guaranteed valid UTF-8.
                out.push_str(
                    std::str::from_utf8(&pending[..valid_up_to])
                        .expect("prefix up to valid_up_to is valid UTF-8"),
                );
                match err.error_len() {
                    // Incomplete sequence at the end — keep it for the next read.
                    None => {
                        pending.drain(..valid_up_to);
                        return out;
                    }
                    // Genuinely invalid bytes — emit a replacement char, skip
                    // them, and keep decoding the remainder.
                    Some(bad_len) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid_up_to + bad_len);
                    }
                }
            }
        }
    }
}

fn new_terminal_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    // A monotonic counter keeps IDs unique even when two terminals start in the
    // same millisecond; otherwise the HashMap insert would silently overwrite
    // (and leak) the earlier session's PTY/child.
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("term-{millis}-{}-{seq}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn drain_utf8_passes_through_ascii() {
        let mut pending = b"hello".to_vec();
        assert_eq!(drain_utf8(&mut pending), "hello");
        assert!(pending.is_empty());
    }

    #[test]
    fn drain_utf8_keeps_incomplete_trailing_sequence() {
        // "中" is 0xE4 0xB8 0xAD. Feed only the first two bytes.
        let full = "中".as_bytes();
        let mut pending = full[..2].to_vec();
        // Nothing decodable yet; both bytes are retained for the next read.
        assert_eq!(drain_utf8(&mut pending), "");
        assert_eq!(pending, full[..2].to_vec());

        // Supply the final byte: the full character now decodes.
        pending.push(full[2]);
        assert_eq!(drain_utf8(&mut pending), "中");
        assert!(pending.is_empty());
    }

    #[test]
    fn drain_utf8_splits_multibyte_across_chunk_boundary() {
        // A chunk that ends mid-character must not corrupt it.
        let text = "héllo世界";
        let bytes = text.as_bytes();
        let mut decoded = String::new();
        let mut pending = Vec::new();
        // Feed one byte at a time — the worst-case split.
        for &b in bytes {
            pending.push(b);
            decoded.push_str(&drain_utf8(&mut pending));
        }
        assert_eq!(decoded, text);
        assert!(pending.is_empty());
    }

    #[test]
    fn drain_utf8_replaces_invalid_bytes_without_stalling() {
        // 0xFF is never valid UTF-8; it must be replaced, not retained forever.
        let mut pending = vec![b'a', 0xFF, b'b'];
        assert_eq!(drain_utf8(&mut pending), "a\u{FFFD}b");
        assert!(pending.is_empty());
    }

    #[test]
    fn new_terminal_id_is_unique_within_same_millisecond() {
        let ids: Vec<String> = (0..1000).map(|_| new_terminal_id()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "terminal ids must be unique");
    }
}
