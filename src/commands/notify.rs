// Desktop notification command (issue #194).
//
// 用户切到别的应用后，任务完成或卡在权限确认弹窗时毫无感知。`desktop_notify`
// 在一次 IPC 内原子完成「前台判定 → 系统通知（macOS 通知中心 / Windows
// toast，可带系统原生提示音）→ 请求窗口注意力（macOS dock 弹跳 / Windows
// 任务栏闪烁）」。
//
// 前台判定放在 Rust 侧：托盘隐藏 / 最小化时 webview 的 document.hasFocus()
// 不可靠，而 window.is_focused() 是权威信号；同时避免「前端查焦点 → 发通知」
// 之间的时间窗。
//
// 系统通知发送失败（例如 macOS 用户拒绝了通知授权）不算命令错误——写进
// 结果的 `error` 字段，前端据此回退到 WebAudio 提示音，绝不打断聊天主流程。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, UserAttentionType};
use tauri_plugin_notification::NotificationExt;

use crate::error::AppError;
use crate::tray::MAIN_WINDOW_LABEL;

const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 300;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotifyInput {
    /// "approval" | "complete" | "error" | "test"
    pub kind: String,
    pub title: String,
    pub body: String,
    /// 设置「系统通知」开关；关闭时仍可请求窗口注意力。
    pub show_system_notification: bool,
    /// 设置「提示音」开关：系统通知自带的原生声音。
    pub with_sound: bool,
    /// 设置「仅窗口在后台时通知」；测试按钮传 false 以便前台也能看到效果。
    pub respect_focus: bool,
    pub request_attention: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotifyResult {
    /// 系统通知已实际发出。
    pub delivered: bool,
    /// 调用时主窗口是否在前台（前端据此决定要不要补播提示音）。
    pub focused: bool,
    pub attention_requested: bool,
    /// 系统通知发送失败的原因（非致命，不走 Err）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotifyKind {
    Approval,
    Complete,
    Error,
    Test,
}

fn parse_kind(kind: &str) -> Option<NotifyKind> {
    match kind {
        "approval" => Some(NotifyKind::Approval),
        "complete" => Some(NotifyKind::Complete),
        "error" => Some(NotifyKind::Error),
        "test" => Some(NotifyKind::Test),
        _ => None,
    }
}

/// 权限确认会阻塞任务，用 Critical（macOS dock 持续弹跳 / Windows 任务栏持续
/// 闪烁直到用户回来）；其余场景 Informational 提醒一次即可。
fn attention_type(kind: NotifyKind) -> UserAttentionType {
    match kind {
        NotifyKind::Approval => UserAttentionType::Critical,
        _ => UserAttentionType::Informational,
    }
}

/// 去掉控制字符并按 char 截断（多字节字符不会被截半）。
fn sanitize_text(input: &str, max_chars: usize) -> String {
    let cleaned: String = input
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn is_foreground(focused: bool, minimized: bool, visible: bool) -> bool {
    focused && !minimized && visible
}

fn should_suppress(respect_focus: bool, foreground: bool) -> bool {
    respect_focus && foreground
}

fn system_sound_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Glass"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Default"
    }
}

// async + spawn_blocking：同步 command 在主线程上执行，而 `builder.show()`
// 是阻塞的系统调用（Linux 上经 zbus 走同步 D-Bus 往返），通知系统卡顿时会
// 冻结整个 UI；挪到阻塞线程池后主线程和 async runtime 都不受影响。
#[tauri::command]
pub async fn desktop_notify(
    app: AppHandle,
    input: DesktopNotifyInput,
) -> Result<DesktopNotifyResult, AppError> {
    let kind = parse_kind(&input.kind)
        .ok_or_else(|| AppError::InvalidRequest(format!("unknown notify kind: {}", input.kind)))?;
    let title = sanitize_text(&input.title, MAX_TITLE_CHARS);
    if title.is_empty() {
        return Err(AppError::InvalidRequest(
            "notify title must not be empty".to_string(),
        ));
    }
    let body = sanitize_text(&input.body, MAX_BODY_CHARS);

    tauri::async_runtime::spawn_blocking(move || notify_blocking(&app, kind, &title, &body, &input))
        .await
        .map_err(|e| AppError::Internal(format!("desktop_notify task failed: {e}")))
}

fn notify_blocking(
    app: &AppHandle,
    kind: NotifyKind,
    title: &str,
    body: &str,
    input: &DesktopNotifyInput,
) -> DesktopNotifyResult {
    let window = app.get_webview_window(MAIN_WINDOW_LABEL);
    let foreground = window
        .as_ref()
        .map(|w| {
            // On a Tauri query error, bias every signal toward "not
            // foreground" so an uncertain window state still delivers the
            // notification: missing an approval prompt is the failure this
            // feature exists to prevent, a redundant toast is harmless.
            is_foreground(
                w.is_focused().unwrap_or(false),
                w.is_minimized().unwrap_or(true),
                w.is_visible().unwrap_or(false),
            )
        })
        .unwrap_or(false);

    if should_suppress(input.respect_focus, foreground) {
        return DesktopNotifyResult {
            delivered: false,
            focused: foreground,
            attention_requested: false,
            error: None,
        };
    }

    let mut delivered = false;
    let mut error = None;
    if input.show_system_notification {
        let mut builder = app.notification().builder().title(title).body(body);
        if input.with_sound {
            builder = builder.sound(system_sound_name());
        }
        match builder.show() {
            Ok(()) => delivered = true,
            Err(err) => {
                log::warn!("System notification failed: {}", err);
                error = Some(err.to_string());
            }
        }
    }

    let mut attention_requested = false;
    if input.request_attention && !foreground {
        if let Some(window) = window.as_ref() {
            match window.request_user_attention(Some(attention_type(kind))) {
                Ok(()) => attention_requested = true,
                Err(err) => log::debug!("request_user_attention failed: {}", err),
            }
        }
    }

    DesktopNotifyResult {
        delivered,
        focused: foreground,
        attention_requested,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn parse_kind_accepts_known_kinds() {
        assert_eq!(parse_kind("approval"), Some(NotifyKind::Approval));
        assert_eq!(parse_kind("complete"), Some(NotifyKind::Complete));
        assert_eq!(parse_kind("error"), Some(NotifyKind::Error));
        assert_eq!(parse_kind("test"), Some(NotifyKind::Test));
    }

    #[test]
    fn parse_kind_rejects_unknown_kinds() {
        assert_eq!(parse_kind(""), None);
        assert_eq!(parse_kind("Approval"), None);
        assert_eq!(parse_kind("warn"), None);
    }

    #[test]
    fn approval_uses_critical_attention_others_informational() {
        assert!(matches!(
            attention_type(NotifyKind::Approval),
            UserAttentionType::Critical
        ));
        assert!(matches!(
            attention_type(NotifyKind::Complete),
            UserAttentionType::Informational
        ));
        assert!(matches!(
            attention_type(NotifyKind::Error),
            UserAttentionType::Informational
        ));
        assert!(matches!(
            attention_type(NotifyKind::Test),
            UserAttentionType::Informational
        ));
    }

    #[test]
    fn sanitize_text_strips_control_chars_and_trims() {
        assert_eq!(
            sanitize_text("  hello\nworld\t!\u{0007} ", 100),
            "hello world !"
        );
    }

    #[test]
    fn sanitize_text_truncates_by_chars_not_bytes() {
        // 5 个中文字符截到 4：保留 3 个 + 省略号，不会在多字节边界 panic。
        assert_eq!(sanitize_text("一二三四五", 4), "一二三…");
        assert_eq!(sanitize_text("一二三四", 4), "一二三四");
    }

    #[test]
    fn sanitize_text_empty_input_stays_empty() {
        assert_eq!(sanitize_text("   \n\t  ", 10), "");
    }

    #[test]
    fn is_foreground_truth_table() {
        // Exhaustive: only (focused, !minimized, visible) is foreground.
        assert!(is_foreground(true, false, true));
        assert!(!is_foreground(false, false, true));
        assert!(!is_foreground(true, true, true));
        assert!(!is_foreground(true, false, false));
        assert!(!is_foreground(false, true, false));
        assert!(!is_foreground(true, true, false));
        assert!(!is_foreground(false, true, true));
        assert!(!is_foreground(false, false, false));
    }

    #[test]
    fn should_suppress_only_when_respecting_focus_in_foreground() {
        assert!(should_suppress(true, true));
        assert!(!should_suppress(true, false));
        assert!(!should_suppress(false, true));
        assert!(!should_suppress(false, false));
    }

    #[test]
    fn system_sound_name_matches_platform() {
        #[cfg(target_os = "macos")]
        assert_eq!(system_sound_name(), "Glass");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(system_sound_name(), "Default");
    }

    #[test]
    fn input_deserializes_from_camel_case() {
        let input: DesktopNotifyInput = serde_json::from_value(serde_json::json!({
            "kind": "approval",
            "title": "需要权限确认",
            "body": "rm -rf build",
            "showSystemNotification": true,
            "withSound": true,
            "respectFocus": true,
            "requestAttention": true,
        }))
        .unwrap();
        assert_eq!(input.kind, "approval");
        assert!(input.show_system_notification);
        assert!(input.with_sound);
        assert!(input.respect_focus);
        assert!(input.request_attention);
    }

    #[test]
    fn result_serializes_to_camel_case_and_skips_empty_error() {
        let ok = DesktopNotifyResult {
            delivered: true,
            focused: false,
            attention_requested: true,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({
                "delivered": true,
                "focused": false,
                "attentionRequested": true,
            })
        );

        let failed = DesktopNotifyResult {
            delivered: false,
            focused: false,
            attention_requested: false,
            error: Some("denied".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&failed).unwrap()["error"],
            serde_json::json!("denied")
        );
    }
}
