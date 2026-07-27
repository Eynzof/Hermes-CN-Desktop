// Runtime update state machine.
//
// Inspired by Warp's autoupdate/mod.rs: clear enum-based stages make the
// update lifecycle visible to the frontend and simplify error recovery.
//
// Stages are pushed to the webview as `runtime-update-stage` events while a
// runtime install/rollback is in flight (commands/runtime_manager.rs threads a
// sink into process/runtime.rs); the update overlay renders them as progress.

use serde::Serialize;

/// Tauri event name carrying [`UpdateStage`] payloads to the webview.
pub const RUNTIME_UPDATE_STAGE_EVENT: &str = "runtime-update-stage";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum UpdateStage {
    Idle,
    Checking,
    NoUpdateAvailable,
    UpdateAvailable {
        current_version: Option<String>,
        new_version: String,
    },
    Downloading {
        new_version: String,
    },
    Verifying {
        new_version: String,
    },
    Extracting {
        new_version: String,
    },
    SmokeChecking {
        new_version: String,
    },
    Installing {
        new_version: String,
    },
    RestartingDashboard {
        new_version: String,
    },
    /// Half-updated: the new runtime is already installed on disk, but the
    /// dashboard restart failed. The update itself succeeded — the frontend
    /// must ask the user to restart the app, not report a failed update.
    RestartRequired {
        new_version: String,
    },
    Complete {
        new_version: String,
        previous_version: Option<String>,
    },
    Failed {
        error: String,
        new_version: Option<String>,
    },
    RollingBack,
    RolledBack {
        restored_version: String,
    },
}

impl UpdateStage {
    pub fn emit(&self, app: &tauri::AppHandle) {
        use tauri::Emitter;
        let _ = app.emit(RUNTIME_UPDATE_STAGE_EVENT, self);
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            UpdateStage::Idle
                | UpdateStage::NoUpdateAvailable
                | UpdateStage::RestartRequired { .. }
                | UpdateStage::Complete { .. }
                | UpdateStage::Failed { .. }
                | UpdateStage::RolledBack { .. }
        )
    }

    pub fn is_in_progress(&self) -> bool {
        !self.is_terminal()
            && !matches!(
                self,
                UpdateStage::Idle | UpdateStage::UpdateAvailable { .. }
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn v(s: &str) -> String {
        s.to_string()
    }

    #[test]
    fn terminal_states_are_terminal() {
        assert!(UpdateStage::Idle.is_terminal());
        assert!(UpdateStage::NoUpdateAvailable.is_terminal());
        assert!(UpdateStage::Complete {
            new_version: v("1"),
            previous_version: None
        }
        .is_terminal());
        assert!(UpdateStage::Failed {
            error: v("e"),
            new_version: None
        }
        .is_terminal());
        assert!(UpdateStage::RolledBack {
            restored_version: v("0.9")
        }
        .is_terminal());
        // Half-updated is terminal: the install itself finished — only a
        // manual app restart is pending. Never render it as "in progress".
        assert!(UpdateStage::RestartRequired {
            new_version: v("1")
        }
        .is_terminal());
    }

    #[test]
    fn active_states_are_not_terminal() {
        assert!(!UpdateStage::Checking.is_terminal());
        assert!(!UpdateStage::UpdateAvailable {
            current_version: None,
            new_version: v("1")
        }
        .is_terminal());
        assert!(!UpdateStage::Downloading {
            new_version: v("1")
        }
        .is_terminal());
        assert!(!UpdateStage::Verifying {
            new_version: v("1")
        }
        .is_terminal());
        assert!(!UpdateStage::Extracting {
            new_version: v("1")
        }
        .is_terminal());
        assert!(!UpdateStage::SmokeChecking {
            new_version: v("1")
        }
        .is_terminal());
        assert!(!UpdateStage::Installing {
            new_version: v("1")
        }
        .is_terminal());
        assert!(!UpdateStage::RestartingDashboard {
            new_version: v("1")
        }
        .is_terminal());
        assert!(!UpdateStage::RollingBack.is_terminal());
    }

    #[test]
    fn active_install_stages_are_in_progress() {
        assert!(UpdateStage::Checking.is_in_progress());
        assert!(UpdateStage::Downloading {
            new_version: v("1")
        }
        .is_in_progress());
        assert!(UpdateStage::Verifying {
            new_version: v("1")
        }
        .is_in_progress());
        assert!(UpdateStage::Extracting {
            new_version: v("1")
        }
        .is_in_progress());
        assert!(UpdateStage::SmokeChecking {
            new_version: v("1")
        }
        .is_in_progress());
        assert!(UpdateStage::Installing {
            new_version: v("1")
        }
        .is_in_progress());
        assert!(UpdateStage::RestartingDashboard {
            new_version: v("1")
        }
        .is_in_progress());
        assert!(UpdateStage::RollingBack.is_in_progress());
    }

    #[test]
    fn terminal_states_are_not_in_progress() {
        assert!(!UpdateStage::Idle.is_in_progress());
        assert!(!UpdateStage::NoUpdateAvailable.is_in_progress());
        assert!(!UpdateStage::Complete {
            new_version: v("1"),
            previous_version: None
        }
        .is_in_progress());
        assert!(!UpdateStage::Failed {
            error: v("e"),
            new_version: None
        }
        .is_in_progress());
        assert!(!UpdateStage::RolledBack {
            restored_version: v("0.9")
        }
        .is_in_progress());
    }

    #[test]
    fn update_available_is_neither_terminal_nor_in_progress() {
        // Distinct "awaiting user confirmation" state — explicit by design.
        let s = UpdateStage::UpdateAvailable {
            current_version: Some(v("0.9")),
            new_version: v("1.0"),
        };
        assert!(!s.is_terminal());
        assert!(!s.is_in_progress());
    }

    #[test]
    fn serialize_emits_stage_tag() {
        let json = serde_json::to_value(UpdateStage::Idle).unwrap();
        assert_eq!(json["stage"], "idle");

        // rename_all = "camelCase" applies to variant identifiers only; struct
        // variant fields stay snake_case. Lock that contract — the frontend
        // consumes new_version, not newVersion.
        let json = serde_json::to_value(UpdateStage::Downloading {
            new_version: v("1.2.3"),
        })
        .unwrap();
        assert_eq!(json["stage"], "downloading");
        assert_eq!(json["new_version"], "1.2.3");
    }
}
