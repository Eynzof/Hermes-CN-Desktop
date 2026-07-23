// Small cross-cutting helpers shared across modules.

/// Whether a string represents a truthy flag value.
///
/// Shared by environment-variable flags (`process::dashboard::env_flag`) and
/// persisted UI-store values (`ui_store::value_is_truthy`) so the accepted token
/// set stays identical no matter where the value comes from.
pub fn str_is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Windows 上给控制台子命令（tasklist/taskkill/powershell/git 等）加
/// `CREATE_NO_WINDOW`，防止 GUI 进程启动它们时系统分配可见控制台弹出黑窗。
///
/// 注意：`creation_flags` 是整体赋值而非按位 OR，因此本 helper 只适用于
/// 尚未设置 creation flags 的调用点；需要组合其他 flag（如
/// `CREATE_NEW_PROCESS_GROUP`）的 spawn 路径应自行设置完整组合。
#[cfg(windows)]
pub fn hide_console_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// 非 Windows 平台不存在控制台窗口问题，no-op。
#[cfg(not(windows))]
pub fn hide_console_window(_cmd: &mut std::process::Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthy_tokens() {
        for v in ["1", "true", "TRUE", " on ", "Yes"] {
            assert!(str_is_truthy(v), "{v} should be truthy");
        }
        for v in ["0", "false", "off", "", "2", "no"] {
            assert!(!str_is_truthy(v), "{v} should be falsy");
        }
    }
}
