//! Unified release manifest — single `version` governing BOTH the desktop
//! installer and the backend runtime zip.
//!
//! The landing site (`https://desktop.hermesagent.org.cn/latest.json`) evolves
//! into this schema so a one-click "检查更新 / 更新" can install the frontend
//! and backend together at the same version:
//!
//! ```json
//! {
//!   "schemaVersion": 1,
//!   "version": "0.8.0",
//!   "publishedAt": "2026-01-01T00:00:00Z",
//!   "minAppVersion": "0.7.0",
//!   "assets": {
//!     "win32-x64": {
//!       "desktop": { "kind": "nsis", "fileName": "...setup.exe", "url": "...", "sha256": "...", "size": 123 },
//!       "runtime": {
//!         "kind": "runtime",
//!         "fileName": "hermes-runtime-0.8.0-win32-x64.zip",
//!         "url": "...",
//!         "sha256": "...",
//!         "size": 456,
//!         "kernelVersion": "0.8.0",
//!         "manifest": { /* full signed track-A RuntimeUpdateManifest (camelCase) */ }
//!       }
//!     }
//!   }
//! }
//! ```
//!
//! ## Same-version hard constraint
//!
//! The top-level `version` MUST equal `runtime.kernelVersion` AND
//! `runtime.manifest.kernelVersion`. When they differ the manifest is invalid
//! (`same_version == false`) and the UI must not offer an update — the desktop
//! and backend would end up on different versions.
//!
//! ## Why the runtime asset embeds the signed track-A manifest
//!
//! The backend zip is verified by the existing track-A engine
//! ([`crate::process::runtime::install_runtime_update`]), which recomputes a
//! 12-field signature payload from a [`RuntimeUpdateManifest`] and checks it
//! with the baked Ed25519 public key. Re-encoding the payload from display
//! fields here would break that verification, so the unified manifest carries
//! the already-signed track-A manifest verbatim; the desktop passes it through
//! unchanged.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::process::runtime::RuntimeUpdateManifest;

pub const UNIFIED_MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Platform key used in `assets`: `"{platform}-{arch}"`, e.g. `win32-x64`.
pub fn platform_asset_key() -> String {
    format!(
        "{}-{}",
        crate::process::runtime::current_platform(),
        crate::process::runtime::current_arch()
    )
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDesktopAsset {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedRuntimeAsset {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub file_name: String,
    /// Display copy of the download URL. The authoritative URL lives inside
    /// [`Self::manifest`] (it is part of the signature payload).
    #[serde(default)]
    pub url: String,
    /// Display copy of the sha256. The authoritative value lives inside
    /// [`Self::manifest`].
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
    /// Must equal the top-level `version` (same-version constraint).
    #[serde(default)]
    pub kernel_version: String,
    /// The already-signed track-A runtime manifest, passed through verbatim to
    /// [`crate::process::runtime::install_runtime_update`].
    pub manifest: RuntimeUpdateManifest,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedPlatformAssets {
    #[serde(default)]
    pub desktop: Option<UnifiedDesktopAsset>,
    #[serde(default)]
    pub runtime: Option<UnifiedRuntimeAsset>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedReleaseManifest {
    pub schema_version: u32,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub assets: BTreeMap<String, UnifiedPlatformAssets>,
    // Legacy fields kept for `desktop_update.rs` notification compatibility.
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub semver: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
}

impl UnifiedReleaseManifest {
    /// Normalize the top-level version: prefer `version`, fall back to the
    /// legacy `semver` field so old manifests still parse.
    pub fn normalized_version(&self) -> Option<String> {
        let v = self.version.trim();
        if !v.is_empty() {
            return Some(v.trim_start_matches('v').to_string());
        }
        self.semver
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_start_matches('v').to_string())
    }

    /// The assets for the current platform/arch.
    pub fn current_platform_assets(&self) -> Option<&UnifiedPlatformAssets> {
        self.assets.get(&platform_asset_key())
    }

    /// The current-platform runtime asset, if any.
    pub fn current_runtime_asset(&self) -> Option<&UnifiedRuntimeAsset> {
        self.current_platform_assets()
            .and_then(|a| a.runtime.as_ref())
    }

    /// The current-platform desktop asset, if any.
    pub fn current_desktop_asset(&self) -> Option<&UnifiedDesktopAsset> {
        self.current_platform_assets()
            .and_then(|a| a.desktop.as_ref())
    }

    /// Enforce the same-version hard constraint:
    /// `version == runtime.kernelVersion == runtime.manifest.kernel_version`.
    /// Returns `true` when the manifest is internally consistent for this
    /// platform's runtime asset; manifests without a runtime asset for this
    /// platform count as "same version" (nothing to compare) but are not
    /// installable via the unified flow.
    pub fn same_version(&self) -> bool {
        let version = match self.normalized_version() {
            Some(v) => v,
            None => return false,
        };
        match self.current_runtime_asset() {
            None => true,
            Some(asset) => {
                let asset_kernel = asset.kernel_version.trim().trim_start_matches('v');
                let manifest_kernel = asset.manifest.kernel_version.trim().trim_start_matches('v');
                asset_kernel == version && manifest_kernel == version
            }
        }
    }

    /// Human-readable reason when [`Self::same_version`] is false.
    pub fn same_version_error(&self) -> Option<String> {
        if self.same_version() {
            return None;
        }
        let version = self.normalized_version().unwrap_or_default();
        let detail = match self.current_runtime_asset() {
            None => "清单缺少当前平台的 runtime 产物".to_string(),
            Some(asset) => format!(
                "顶层 version={}，runtime.kernelVersion={}，runtime.manifest.kernelVersion={}",
                version,
                asset.kernel_version.trim().trim_start_matches('v'),
                asset.manifest.kernel_version.trim().trim_start_matches('v'),
            ),
        };
        Some(format!("前后端版本不一致（{}）", detail))
    }

    /// Convert the unified runtime asset into the track-A manifest the install
    /// engine expects. This is a pass-through of the embedded signed manifest;
    /// nothing is rewritten, so signature verification stays intact.
    pub fn runtime_update_manifest(&self) -> Option<&RuntimeUpdateManifest> {
        self.current_runtime_asset().map(|a| &a.manifest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn signed_runtime_manifest(kernel_version: &str) -> RuntimeUpdateManifest {
        RuntimeUpdateManifest {
            schema_version: 2,
            channel: "stable".to_string(),
            runtime_version: "0.8.0".to_string(),
            kernel_version: kernel_version.to_string(),
            runtime_flavor: "cn".to_string(),
            runtime_revision: 0,
            platform: crate::process::runtime::current_platform().to_string(),
            arch: crate::process::runtime::current_arch().to_string(),
            artifact_url: "https://desktop.hermesagent.org.cn/runtime/artifacts/0.8.0/x.zip"
                .to_string(),
            sha256: "abc123".to_string(),
            signature: "ZmFrZXNpZw==".to_string(),
            source_repo: "Eynzof/Hermes-CN-Core".to_string(),
            source_commit: "deadbeef".to_string(),
            min_app_version: Some("0.7.0".to_string()),
            created_at: None,
        }
    }

    fn manifest_with(kernel_version: &str, top_version: &str) -> UnifiedReleaseManifest {
        UnifiedReleaseManifest {
            schema_version: 1,
            version: top_version.to_string(),
            published_at: Some("2026-01-01T00:00:00Z".to_string()),
            min_app_version: Some("0.7.0".to_string()),
            assets: BTreeMap::from([(
                platform_asset_key(),
                UnifiedPlatformAssets {
                    desktop: Some(UnifiedDesktopAsset {
                        kind: "nsis".to_string(),
                        file_name: "Hermes.Agent.CN.Desktop_0.8.0_x64-setup.exe".to_string(),
                        url: "https://desktop.hermesagent.org.cn/download/0.8.0/setup.exe"
                            .to_string(),
                        sha256: "def456".to_string(),
                        size: Some(123),
                    }),
                    runtime: Some(UnifiedRuntimeAsset {
                        kind: "runtime".to_string(),
                        file_name: "hermes-runtime-0.8.0-win32-x64.zip".to_string(),
                        url: "https://desktop.hermesagent.org.cn/runtime/artifacts/0.8.0/x.zip"
                            .to_string(),
                        sha256: "abc123".to_string(),
                        size: Some(456),
                        kernel_version: kernel_version.to_string(),
                        manifest: signed_runtime_manifest(kernel_version),
                    }),
                },
            )]),
            ..Default::default()
        }
    }

    #[test]
    fn parses_full_unified_manifest() {
        let json = serde_json::json!({
            "schemaVersion": 1,
            "version": "0.8.0",
            "minAppVersion": "0.7.0",
            "assets": {
                platform_asset_key(): {
                    "desktop": { "kind": "nsis", "fileName": "x.exe", "url": "https://e/x.exe", "sha256": "a", "size": 1 },
                    "runtime": {
                        "kind": "runtime", "fileName": "r.zip", "url": "https://e/r.zip",
                        "sha256": "b", "size": 2, "kernelVersion": "0.8.0",
                        "manifest": {
                            "schemaVersion": 2, "channel": "stable",
                            "runtimeVersion": "0.8.0", "kernelVersion": "0.8.0",
                            "runtimeFlavor": "cn", "runtimeRevision": 0,
                            "platform": crate::process::runtime::current_platform(),
                            "arch": crate::process::runtime::current_arch(),
                            "artifactUrl": "https://e/r.zip", "sha256": "b",
                            "signature": "ZmFrZQ==", "sourceRepo": "r", "sourceCommit": "c"
                        }
                    }
                }
            }
        });
        let manifest: UnifiedReleaseManifest = serde_json::from_value(json).unwrap();
        assert_eq!(manifest.normalized_version().as_deref(), Some("0.8.0"));
        assert!(manifest.same_version());
        assert!(manifest.same_version_error().is_none());
        assert!(manifest.runtime_update_manifest().is_some());
        assert_eq!(manifest.current_desktop_asset().unwrap().kind, "nsis");
    }

    #[test]
    fn same_version_passes_when_all_equal() {
        let m = manifest_with("0.8.0", "0.8.0");
        assert!(m.same_version());
        assert!(m.same_version_error().is_none());
    }

    #[test]
    fn same_version_fails_when_asset_kernel_differs() {
        let m = manifest_with("0.9.0", "0.8.0");
        assert!(!m.same_version());
        assert!(m.same_version_error().unwrap().contains("前后端版本不一致"));
    }

    #[test]
    fn same_version_fails_when_embedded_manifest_kernel_differs() {
        // Top-level version and asset.kernelVersion agree, but the embedded
        // signed manifest disagrees — still invalid.
        let mut m = manifest_with("0.8.0", "0.8.0");
        m.assets
            .get_mut(&platform_asset_key())
            .unwrap()
            .runtime
            .as_mut()
            .unwrap()
            .manifest
            .kernel_version = "0.7.0".to_string();
        assert!(!m.same_version());
    }

    #[test]
    fn same_version_tolerates_v_prefix() {
        let mut m = manifest_with("v0.8.0", "0.8.0");
        m.assets
            .get_mut(&platform_asset_key())
            .unwrap()
            .runtime
            .as_mut()
            .unwrap()
            .manifest
            .kernel_version = "0.8.0".to_string();
        assert!(m.same_version());
    }

    #[test]
    fn missing_version_is_not_same_version() {
        let mut m = manifest_with("0.8.0", "");
        m.version = String::new();
        assert!(!m.same_version());
    }

    #[test]
    fn runtime_update_manifest_is_pass_through() {
        let m = manifest_with("0.8.0", "0.8.0");
        let rt = m.runtime_update_manifest().unwrap();
        assert_eq!(rt.kernel_version, "0.8.0");
        assert_eq!(
            rt.artifact_url,
            "https://desktop.hermesagent.org.cn/runtime/artifacts/0.8.0/x.zip"
        );
        assert_eq!(rt.signature, "ZmFrZXNpZw==");
    }

    #[test]
    fn platform_key_matches_runtime_naming() {
        let key = platform_asset_key();
        let (platform, arch) = key.split_once('-').unwrap();
        assert_eq!(platform, crate::process::runtime::current_platform());
        assert_eq!(arch, crate::process::runtime::current_arch());
    }
}
