//! Compile-time desktop distribution flavor.
//!
//! The standard build owns a managed Hermes runtime. The shell build is a
//! deliberately strict attach-only client: it may connect to a local CLI or a
//! remote Hermes, but it must never install, download, or spawn a managed
//! runtime. Keep this policy centralized so UI hiding is not the only guard.

use crate::error::{AppError, AppResult};

pub const STANDARD_APP_IDENTIFIER: &str = "cn.org.hermesagent.desktop";
pub const SHELL_APP_IDENTIFIER: &str = "cn.org.hermesagent.desktop.shell";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopBuildFlavor {
    Standard,
    Shell,
}

impl DesktopBuildFlavor {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Shell => "shell",
        }
    }

    pub const fn app_identifier(self) -> &'static str {
        match self {
            Self::Standard => STANDARD_APP_IDENTIFIER,
            Self::Shell => SHELL_APP_IDENTIFIER,
        }
    }
}

pub const fn current() -> DesktopBuildFlavor {
    if cfg!(feature = "shell-only") {
        DesktopBuildFlavor::Shell
    } else {
        DesktopBuildFlavor::Standard
    }
}

pub const fn is_shell() -> bool {
    matches!(current(), DesktopBuildFlavor::Shell)
}

pub fn require_managed_runtime(capability: &str) -> AppResult<()> {
    if is_shell() {
        Err(AppError::InvalidRequest(format!(
            "{}不可用于本地 CLI 壳版；壳版不包含、下载或启动内置内核",
            capability
        )))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compile_time_flavor_has_matching_identifier_and_capability() {
        if cfg!(feature = "shell-only") {
            assert_eq!(current(), DesktopBuildFlavor::Shell);
            assert_eq!(current().app_identifier(), SHELL_APP_IDENTIFIER);
            assert!(require_managed_runtime("内核安装").is_err());
        } else {
            assert_eq!(current(), DesktopBuildFlavor::Standard);
            assert_eq!(current().app_identifier(), STANDARD_APP_IDENTIFIER);
            assert!(require_managed_runtime("内核安装").is_ok());
        }
    }
}
