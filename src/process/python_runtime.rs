//! Embedded Python payload management (report Phase 1 / Phase 5).
//!
//! The embedded runtime reuses the same PyInstaller payload the subprocess
//! managed runtime already ships (static/bundled-runtime/… zip → extracted
//! `_internal`), so download/signature verification stays with `runtime.rs` and
//! this module only:
//! - locates the payload root,
//! - validates that it contains a usable `hermes_embedded` package,
//! - reads the Python-side `ffi_surface_version` for the startup contract
//!   check (report §8 success criteria 11).
//!
//! Updates are "download new payload → verify → replace → restart" (not
//! in-process hot swap); the actual replacement/recovery machinery is shared
//! with `runtime.rs` (`install_runtime_update`).

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Kind of embedded payload we located.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadKind {
    /// A dev checkout of the real `hermes_embedded` package (Core checkout / dev spike).
    DevPackage,
    /// A PyInstaller `_internal` extraction (production payload).
    PyInstallerInternal,
    /// A staged Tauri resource directory (`static/embedded-python`).
    StagedResource,
}

/// Resolved embedded payload location + metadata.
#[derive(Debug, Clone)]
pub struct EmbeddedPayloadInfo {
    pub root: PathBuf,
    pub kind: PayloadKind,
}

/// Locate the embedded payload. Mirrors `crate::embedded::resolve_payload_root`
/// but returns richer metadata and performs validation.
pub fn locate_payload(resource_dir: Option<&Path>) -> Option<EmbeddedPayloadInfo> {
    let root = crate::embedded::resolve_payload_root(resource_dir)?;
    let kind = if root.join("hermes_embedded").join("api.py").is_file()
        && root.join("hermes_embedded").join("__init__.py").is_file()
    {
        if root.ends_with("static") || root.ends_with("embedded-python") {
            PayloadKind::StagedResource
        } else {
            PayloadKind::DevPackage
        }
    } else if root.join("base_library.zip").is_file() || root.join("python3.dll").is_file() {
        PayloadKind::PyInstallerInternal
    } else {
        PayloadKind::DevPackage
    };
    Some(EmbeddedPayloadInfo { root, kind })
}

/// Validate the payload: the embedded API package must exist and expose
/// `ffi_surface_version`.
pub fn validate_payload(info: &EmbeddedPayloadInfo) -> AppResult<()> {
    let pkg = info.root.join("hermes_embedded");
    if !pkg.join("__init__.py").is_file() {
        return Err(AppError::EmbeddedPython {
            msg: format!(
                "payload {} is missing hermes_embedded/__init__.py",
                info.root.display()
            ),
            traceback: None,
        });
    }
    if !pkg.join("api.py").is_file() {
        return Err(AppError::EmbeddedPython {
            msg: format!(
                "payload {} is missing hermes_embedded/api.py",
                info.root.display()
            ),
            traceback: None,
        });
    }
    if read_ffi_surface_version(&pkg).is_none() {
        return Err(AppError::EmbeddedPython {
            msg: format!(
                "payload {} hermes_embedded/api.py does not define ffi_surface_version",
                info.root.display()
            ),
            traceback: None,
        });
    }
    Ok(())
}

/// Parse `ffi_surface_version` out of the Python package without importing it
/// (used before the interpreter starts). Handles both a direct quoted string
/// (`ffi_surface_version = "0.1.0"`) and an indirection
/// (`ffi_surface_version = FFI_SURFACE_VERSION`).
pub fn read_ffi_surface_version(pkg_dir: &Path) -> Option<String> {
    let api_py = pkg_dir.join("api.py");
    let text = std::fs::read_to_string(api_py).ok()?;

    // First pass: map every quoted constant assignment (name -> value).
    let mut constants: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some((lhs, rhs)) = trimmed.split_once('=') {
            let value = rhs.trim();
            if value.starts_with('"') || value.starts_with('\'') {
                constants.insert(
                    lhs.trim(),
                    value.trim_matches('"').trim_matches('\'').to_string(),
                );
            }
        }
    }
    if let Some(v) = constants.get("ffi_surface_version") {
        return Some(v.clone());
    }
    // Second pass: `ffi_surface_version = SOME_CONST`.
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some((lhs, rhs)) = trimmed.split_once('=') {
            if lhs.trim() == "ffi_surface_version" {
                let reference = rhs.trim().trim_matches('"').trim_matches('\'');
                if let Some(v) = constants.get(reference) {
                    return Some(v.clone());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn write_package(dir: &Path, version: &str) {
        let pkg = dir.join("hermes_embedded");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("__init__.py"), "").unwrap();
        std::fs::write(
            pkg.join("api.py"),
            format!("ffi_surface_version = \"{version}\"\n"),
        )
        .unwrap();
    }

    #[test]
    fn validates_dev_package_payload() {
        let dir = tempfile::TempDir::new().unwrap();
        write_package(dir.path(), "0.1.0");
        let info = EmbeddedPayloadInfo {
            root: dir.path().to_path_buf(),
            kind: PayloadKind::DevPackage,
        };
        assert!(validate_payload(&info).is_ok());
    }

    #[test]
    fn rejects_missing_api_module() {
        let dir = tempfile::TempDir::new().unwrap();
        let pkg = dir.path().join("hermes_embedded");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("__init__.py"), "").unwrap();
        let info = EmbeddedPayloadInfo {
            root: dir.path().to_path_buf(),
            kind: PayloadKind::DevPackage,
        };
        assert!(validate_payload(&info).is_err());
    }

    #[test]
    fn reads_ffi_surface_version_from_api_py() {
        let dir = tempfile::TempDir::new().unwrap();
        write_package(dir.path(), "0.2.1");
        let pkg = dir.path().join("hermes_embedded");
        assert_eq!(read_ffi_surface_version(&pkg).as_deref(), Some("0.2.1"));
    }

    #[test]
    #[serial_test::serial]
    fn locate_payload_finds_dev_package_via_env() {
        let dir = tempfile::TempDir::new().unwrap();
        write_package(dir.path(), "0.1.0");
        std::env::set_var(
            "HERMES_DESKTOP_EMBEDDED_PAYLOAD",
            dir.path().to_str().unwrap(),
        );
        let info = locate_payload(None).expect("payload should be found");
        assert_eq!(info.root, dir.path());
        assert!(validate_payload(&info).is_ok());
        std::env::remove_var("HERMES_DESKTOP_EMBEDDED_PAYLOAD");
    }
}
