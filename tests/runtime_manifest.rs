// HTTP-boundary tests for runtime update manifest fetching, plus the signed
// v3 gates (minAppVersion forced-upgrade, semver anti-downgrade).
//
// check_runtime_update fetches and parses a remote manifest. It does NOT
// verify the signature (that happens in install_runtime_update). The gate
// tests for install pass a signed manifest directly — both gates fire before
// any artifact download, so no HTTP mock is needed there.
//
// All tests are #[serial] because they mutate HERMES_RUNTIME_UPDATE_* /
// HERMES_DESKTOP_RUNTIME_ROOT process-global env vars.

use hermes_agent_cn::process::runtime::{
    check_runtime_update, install_runtime_update, RuntimeUpdateManifest,
};
use serial_test::serial;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn host_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn host_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    }
}

fn manifest_json(runtime_version: &str) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 2,
        "channel": "stable",
        "runtimeVersion": runtime_version,
        "kernelVersion": runtime_version.split("-cn.").next().unwrap_or(runtime_version),
        "runtimeFlavor": "cn",
        "runtimeRevision": 1,
        "platform": host_platform(),
        "arch": host_arch(),
        "artifactUrl": "https://example.com/foo.zip",
        "sha256": "0".repeat(64),
        "signature": "stub-signature",
        "sourceRepo": "owner/repo",
        "sourceCommit": "abc123",
    })
}

fn clear_env() {
    for var in [
        "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
        "HERMES_RUNTIME_UPDATE_BASE_URL",
        "HERMES_RUNTIME_UPDATE_CHANNEL",
    ] {
        std::env::remove_var(var);
    }
}

#[tokio::test]
#[serial]
async fn returns_manifest_when_remote_responds_with_valid_json() {
    clear_env();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/manifest.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(manifest_json("999.999.999-cn.1")))
        .mount(&server)
        .await;
    std::env::set_var(
        "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
        format!("{}/manifest.json", server.uri()),
    );

    let result = check_runtime_update().await;

    assert!(result.ok, "unexpected error: {:?}", result.error);
    let manifest = result.manifest.expect("manifest should be present");
    assert_eq!(manifest.runtime_version, "999.999.999-cn.1");
    assert_eq!(manifest.platform, host_platform());

    clear_env();
}

#[tokio::test]
#[serial]
async fn returns_error_on_http_404() {
    clear_env();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/manifest.json"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    std::env::set_var(
        "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
        format!("{}/manifest.json", server.uri()),
    );

    let result = check_runtime_update().await;

    assert!(!result.ok);
    let err = result.error.unwrap();
    assert!(err.contains("HTTP") && err.contains("404"), "got: {}", err);

    clear_env();
}

#[tokio::test]
#[serial]
async fn returns_error_on_malformed_json() {
    clear_env();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/manifest.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{ not valid json"))
        .mount(&server)
        .await;
    std::env::set_var(
        "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
        format!("{}/manifest.json", server.uri()),
    );

    let result = check_runtime_update().await;

    assert!(!result.ok);
    let err = result.error.unwrap();
    assert!(err.contains("Failed to parse"), "got: {}", err);

    clear_env();
}

#[tokio::test]
#[serial]
async fn returns_error_for_wrong_platform() {
    clear_env();
    let mut wrong = manifest_json("1.0.0-cn.1");
    wrong["platform"] = serde_json::json!("some-other-os");
    wrong["arch"] = serde_json::json!("some-other-arch");

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/manifest.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(wrong))
        .mount(&server)
        .await;
    std::env::set_var(
        "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
        format!("{}/manifest.json", server.uri()),
    );

    let result = check_runtime_update().await;

    assert!(!result.ok);
    let err = result.error.unwrap();
    assert!(err.contains("Manifest is for"), "got: {}", err);

    clear_env();
}

// -------- v3 schema + signed gates --------

fn clear_gate_env() {
    clear_env();
    for var in [
        "HERMES_DESKTOP_RUNTIME_ROOT",
        "HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM",
    ] {
        std::env::remove_var(var);
    }
}

fn manifest_json_v3(runtime_version: &str, min_app_version: &str) -> serde_json::Value {
    let mut m = manifest_json(runtime_version);
    m["schemaVersion"] = serde_json::json!(3);
    m["minAppVersion"] = serde_json::json!(min_app_version);
    m
}

fn test_keypair() -> (ed25519_dalek::SigningKey, String) {
    use ed25519_dalek::pkcs8::EncodePublicKey;
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
    let pem = signing_key
        .verifying_key()
        .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
        .unwrap();
    (signing_key, pem)
}

/// Mirror of the cross-language signing contract (Core
/// sign_runtime_manifest.py): one field per line, v3 appends minAppVersion.
fn sign_manifest(key: &ed25519_dalek::SigningKey, manifest: &mut RuntimeUpdateManifest) {
    use base64::Engine;
    use ed25519_dalek::Signer;
    let mut payload = format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        manifest.schema_version,
        manifest.channel,
        manifest.runtime_version,
        manifest.kernel_version,
        manifest.runtime_flavor,
        manifest.runtime_revision,
        manifest.platform,
        manifest.arch,
        manifest.artifact_url,
        manifest.sha256,
        manifest.source_repo,
        manifest.source_commit,
    );
    if manifest.schema_version >= 3 {
        payload.push('\n');
        payload.push_str(manifest.min_app_version.as_deref().unwrap_or(""));
    }
    let sig = key.sign(payload.as_bytes());
    manifest.signature = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
}

/// Point the managed runtime tree at a temp dir holding an installed record
/// for `runtime_version`, so read_current_record() resolves it.
fn seed_current_record(root: &std::path::Path, runtime_version: &str) {
    let installed_dir = root.join("versions").join(runtime_version);
    let exe = installed_dir.join("hermes-agent-cn-runtime");
    std::fs::create_dir_all(&installed_dir).unwrap();
    std::fs::write(&exe, b"#!/bin/sh\nexit 0\n").unwrap();
    std::fs::write(
        root.join("current.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 2,
            "runtimeVersion": runtime_version,
            "kernelVersion": runtime_version.split("-cn.").next().unwrap_or(runtime_version),
            "runtimeFlavor": "cn",
            "runtimeRevision": 1,
            "platform": host_platform(),
            "arch": host_arch(),
            "path": installed_dir.display().to_string(),
            "executablePath": exe.display().to_string(),
            "source": "update",
            "installedAt": "2026-07-18T00:00:00.000Z",
        }))
        .unwrap(),
    )
    .unwrap();
}

#[tokio::test]
#[serial]
async fn v3_manifest_with_high_min_app_version_sets_force_flag() {
    clear_gate_env();
    let tmp = tempfile::TempDir::new().unwrap();
    std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/manifest.json"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(manifest_json_v3("999.999.999-cn.1", "999.0.0")),
        )
        .mount(&server)
        .await;
    std::env::set_var(
        "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
        format!("{}/manifest.json", server.uri()),
    );

    let result = check_runtime_update().await;

    assert!(result.ok, "unexpected error: {:?}", result.error);
    assert!(result.update_available);
    assert!(result.force_app_update_required);
    assert_eq!(result.required_app_version.as_deref(), Some("999.0.0"));

    clear_gate_env();
}

#[tokio::test]
#[serial]
async fn v3_manifest_missing_min_app_version_fails_schema_check() {
    clear_gate_env();
    let mut body = manifest_json("999.999.999-cn.1");
    body["schemaVersion"] = serde_json::json!(3);

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/manifest.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;
    std::env::set_var(
        "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
        format!("{}/manifest.json", server.uri()),
    );

    let result = check_runtime_update().await;

    assert!(!result.ok);
    let err = result.error.unwrap();
    assert!(err.contains("minAppVersion"), "got: {}", err);

    clear_gate_env();
}

#[tokio::test]
#[serial]
async fn check_suppresses_downgrade_from_newer_installed_runtime() {
    clear_gate_env();
    let tmp = tempfile::TempDir::new().unwrap();
    std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());
    seed_current_record(tmp.path(), "0.18.5-cn.3");

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/manifest.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(manifest_json("0.18.2-cn.9")))
        .mount(&server)
        .await;
    std::env::set_var(
        "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
        format!("{}/manifest.json", server.uri()),
    );

    let result = check_runtime_update().await;

    assert!(result.ok, "unexpected error: {:?}", result.error);
    assert!(!result.update_available);
    assert!(result.downgrade_blocked);
    assert_eq!(
        result.current_runtime_version.as_deref(),
        Some("0.18.5-cn.3")
    );

    clear_gate_env();
}

#[tokio::test]
#[serial]
async fn install_rejects_signed_manifest_requiring_newer_desktop() {
    clear_gate_env();
    let tmp = tempfile::TempDir::new().unwrap();
    std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());

    let (key, pem) = test_keypair();
    std::env::set_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", pem);

    let mut manifest: RuntimeUpdateManifest =
        serde_json::from_value(manifest_json_v3("999.999.999-cn.1", "999.0.0")).unwrap();
    sign_manifest(&key, &mut manifest);

    // The gate fires after signature verification and before any download,
    // so no artifact server is needed.
    let result = install_runtime_update(Some(manifest), None).await;

    assert!(!result.ok);
    let err = result.error.unwrap();
    assert!(err.contains("升级桌面应用"), "got: {}", err);

    clear_gate_env();
}

#[tokio::test]
#[serial]
async fn install_rejects_signed_downgrade_manifest() {
    clear_gate_env();
    let tmp = tempfile::TempDir::new().unwrap();
    std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());
    seed_current_record(tmp.path(), "0.18.5-cn.3");

    let (key, pem) = test_keypair();
    std::env::set_var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", pem);

    let mut manifest: RuntimeUpdateManifest =
        serde_json::from_value(manifest_json("0.18.2-cn.9")).unwrap();
    sign_manifest(&key, &mut manifest);

    let result = install_runtime_update(Some(manifest), None).await;

    assert!(!result.ok);
    let err = result.error.unwrap();
    assert!(err.contains("降级"), "got: {}", err);

    clear_gate_env();
}
