// Domain error types for the Tauri backend.
//
// Replaces the `Result<T, String>` pattern with typed errors that:
// - Give each failure a clear category for frontend handling
// - Implement Serialize so Tauri can return them to the renderer
// - Implement Display via thiserror for human-readable messages

use serde::Serialize;

#[derive(Debug, Clone, thiserror::Error)]
pub enum AppError {
    // --- Dashboard process ---
    #[error("Dashboard startup failed: {0}")]
    DashboardStartup(String),

    #[error("Dashboard not reachable at {0}")]
    DashboardUnreachable(String),

    #[error("Dashboard probe failed: {0}")]
    DashboardProbe(String),

    // --- Gateway / SSE ---
    #[error("SSE connection failed: {0}")]
    SseConnect(String),

    #[error("SSE stream error: {0}")]
    SseStream(String),

    // --- Runtime management ---
    #[error("Runtime update manifest not configured")]
    RuntimeManifestNotConfigured,

    #[error("Runtime update check failed: {0}")]
    RuntimeCheckFailed(String),

    #[error("Runtime download failed: {0}")]
    RuntimeDownloadFailed(String),

    #[error("Runtime signature verification failed: {0}")]
    RuntimeSignatureInvalid(String),

    #[error("Runtime SHA-256 mismatch: expected {expected}, got {actual}")]
    RuntimeChecksumMismatch { expected: String, actual: String },

    #[error("Runtime extraction failed: {0}")]
    RuntimeExtractFailed(String),

    #[error("Runtime smoke check failed: {0}")]
    RuntimeSmokeFailed(String),

    #[error("Runtime install failed: {0}")]
    RuntimeInstallFailed(String),

    #[error("Runtime unavailable: {0}")]
    RuntimeUnavailable(String),

    #[error("No previous runtime version to rollback to")]
    RuntimeNoPreviousVersion,

    // --- Profile ---
    #[error("Invalid profile name: {0}")]
    ProfileInvalidName(String),

    #[error("Profile directory missing: {0}")]
    ProfileDirMissing(String),

    #[error("Profile switch already in progress")]
    ProfileSwitchInFlight,

    #[error("Desktop is not the dashboard owner")]
    ProfileNotOwner,

    #[error("Profile switch failed: {0}")]
    ProfileSwitchFailed(String),

    // --- API proxy ---
    #[error("Invalid API request: {0}")]
    InvalidRequest(String),

    #[error("API proxy error: {0}")]
    ProxyError(String),

    #[error("Request outside allowed origin: {0}")]
    OriginViolation(String),

    // --- File operations ---
    #[error("File operation failed: {0}")]
    FileError(String),

    // --- State ---
    #[error("App state lock poisoned")]
    StateLockPoisoned,

    #[error("Desktop runtime not ready")]
    NotReady,

    // --- Generic (escape hatch for truly unexpected errors) ---
    #[error("{0}")]
    Internal(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppErrorIpc {
    code: &'static str,
    kind: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<serde_json::Value>,
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::DashboardStartup(_) => "dashboard_startup",
            AppError::DashboardUnreachable(_) => "dashboard_unreachable",
            AppError::DashboardProbe(_) => "dashboard_probe",
            AppError::SseConnect(_) => "sse_connect",
            AppError::SseStream(_) => "sse_stream",
            AppError::RuntimeManifestNotConfigured => "runtime_manifest_not_configured",
            AppError::RuntimeCheckFailed(_) => "runtime_check_failed",
            AppError::RuntimeDownloadFailed(_) => "runtime_download_failed",
            AppError::RuntimeSignatureInvalid(_) => "runtime_signature_invalid",
            AppError::RuntimeChecksumMismatch { .. } => "runtime_checksum_mismatch",
            AppError::RuntimeExtractFailed(_) => "runtime_extract_failed",
            AppError::RuntimeSmokeFailed(_) => "runtime_smoke_failed",
            AppError::RuntimeInstallFailed(_) => "runtime_install_failed",
            AppError::RuntimeUnavailable(_) => "runtime_unavailable",
            AppError::RuntimeNoPreviousVersion => "runtime_no_previous_version",
            AppError::ProfileInvalidName(_) => "profile_invalid_name",
            AppError::ProfileDirMissing(_) => "profile_dir_missing",
            AppError::ProfileSwitchInFlight => "profile_switch_in_flight",
            AppError::ProfileNotOwner => "profile_not_owner",
            AppError::ProfileSwitchFailed(_) => "profile_switch_failed",
            AppError::InvalidRequest(_) => "invalid_request",
            AppError::ProxyError(_) => "proxy_error",
            AppError::OriginViolation(_) => "origin_violation",
            AppError::FileError(_) => "file_error",
            AppError::StateLockPoisoned => "state_lock_poisoned",
            AppError::NotReady => "not_ready",
            AppError::Internal(_) => "internal",
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            AppError::DashboardStartup(_)
            | AppError::DashboardUnreachable(_)
            | AppError::DashboardProbe(_) => "dashboard",
            AppError::SseConnect(_) | AppError::SseStream(_) => "sse",
            AppError::RuntimeManifestNotConfigured
            | AppError::RuntimeCheckFailed(_)
            | AppError::RuntimeDownloadFailed(_)
            | AppError::RuntimeSignatureInvalid(_)
            | AppError::RuntimeChecksumMismatch { .. }
            | AppError::RuntimeExtractFailed(_)
            | AppError::RuntimeSmokeFailed(_)
            | AppError::RuntimeInstallFailed(_)
            | AppError::RuntimeUnavailable(_)
            | AppError::RuntimeNoPreviousVersion => "runtime",
            AppError::ProfileInvalidName(_)
            | AppError::ProfileDirMissing(_)
            | AppError::ProfileSwitchInFlight
            | AppError::ProfileNotOwner
            | AppError::ProfileSwitchFailed(_) => "profile",
            AppError::InvalidRequest(_)
            | AppError::ProxyError(_)
            | AppError::OriginViolation(_) => "api_proxy",
            AppError::FileError(_) => "file",
            AppError::StateLockPoisoned | AppError::NotReady => "state",
            AppError::Internal(_) => "internal",
        }
    }

    fn details(&self) -> Option<serde_json::Value> {
        match self {
            AppError::RuntimeChecksumMismatch { expected, actual } => {
                Some(serde_json::json!({ "expected": expected, "actual": actual }))
            }
            _ => None,
        }
    }
}

// Tauri requires Serialize to return errors to the frontend.
// Keep the human-readable message, but preserve a stable code/kind so the
// frontend can choose recovery UI without parsing localized text.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        AppErrorIpc {
            code: self.code(),
            kind: self.kind(),
            message: self.to_string(),
            details: self.details(),
        }
        .serialize(serializer)
    }
}

// Convenience: convert any std::sync::PoisonError into AppError
impl<T> From<std::sync::PoisonError<T>> for AppError {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        AppError::StateLockPoisoned
    }
}

// Convenience: convert reqwest errors
impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            AppError::ProxyError(format!("Request timed out: {}", e))
        } else if e.is_connect() {
            AppError::DashboardUnreachable(e.to_string())
        } else {
            AppError::ProxyError(e.to_string())
        }
    }
}

// Convenience: convert IO errors
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::FileError(e.to_string())
    }
}

// Convenience: convert URL parse errors
impl From<url::ParseError> for AppError {
    fn from(e: url::ParseError) -> Self {
        AppError::InvalidRequest(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::sync::{Mutex, PoisonError};

    #[test]
    fn from_io_error_maps_to_file_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let app: AppError = io_err.into();
        assert!(matches!(app, AppError::FileError(msg) if msg.contains("denied")));
    }

    #[test]
    fn from_poison_error_maps_to_state_lock_poisoned() {
        let m = Mutex::new(0u8);
        let _ = std::panic::catch_unwind(|| {
            let _guard = m.lock().unwrap();
            panic!("poison");
        });
        let err: AppError = m.lock().unwrap_err().into();
        assert!(matches!(err, AppError::StateLockPoisoned));
    }

    #[test]
    fn from_poison_error_synthetic_also_works() {
        let poison: PoisonError<()> = PoisonError::new(());
        let err: AppError = poison.into();
        assert!(matches!(err, AppError::StateLockPoisoned));
    }

    #[test]
    fn from_url_parse_error_maps_to_invalid_request() {
        let err: url::ParseError = url::Url::parse("not a url").unwrap_err();
        let app: AppError = err.into();
        assert!(matches!(app, AppError::InvalidRequest(_)));
    }

    #[test]
    fn serialize_emits_structured_ipc_error() {
        let err = AppError::DashboardStartup("boom".to_string());
        let json: serde_json::Value = serde_json::to_value(&err).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "code": "dashboard_startup",
                "kind": "dashboard",
                "message": "Dashboard startup failed: boom"
            })
        );
    }

    #[test]
    fn serialize_checksum_error_includes_machine_readable_details() {
        let err = AppError::RuntimeChecksumMismatch {
            expected: "abc".to_string(),
            actual: "def".to_string(),
        };
        let json: serde_json::Value = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "runtime_checksum_mismatch");
        assert_eq!(json["kind"], "runtime");
        assert_eq!(json["details"]["expected"], "abc");
        assert_eq!(json["details"]["actual"], "def");
    }

    #[test]
    fn display_runtime_checksum_mismatch_includes_both_fields() {
        let err = AppError::RuntimeChecksumMismatch {
            expected: "abc".to_string(),
            actual: "def".to_string(),
        };
        let msg = err.to_string();
        assert!(msg.contains("abc"));
        assert!(msg.contains("def"));
        assert!(msg.contains("expected"));
    }

    #[test]
    fn display_dashboard_unreachable_contains_url() {
        let err = AppError::DashboardUnreachable("http://127.0.0.1:9119".to_string());
        assert_eq!(
            err.to_string(),
            "Dashboard not reachable at http://127.0.0.1:9119"
        );
    }

    #[test]
    fn display_origin_violation_contains_origin() {
        let err = AppError::OriginViolation("https://evil.example".to_string());
        assert!(err.to_string().contains("https://evil.example"));
    }

    #[test]
    fn display_runtime_no_previous_version_is_static() {
        let err = AppError::RuntimeNoPreviousVersion;
        assert_eq!(
            err.to_string(),
            "No previous runtime version to rollback to"
        );
    }

    #[test]
    fn display_profile_switch_in_flight_is_static() {
        assert_eq!(
            AppError::ProfileSwitchInFlight.to_string(),
            "Profile switch already in progress"
        );
    }
}
