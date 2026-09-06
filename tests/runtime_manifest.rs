// HTTP-boundary tests for runtime update manifest fetching.
//
// check_runtime_update fetches and parses a remote manifest. It does NOT
// verify the signature (that happens in install_runtime_update). Tests
// here cover the fetch/parse/platform-match path.
//
// All tests are #[serial] because they mutate HERMES_RUNTIME_UPDATE_*
// process-global env vars.

use hermes_agent_cn::process::runtime::check_runtime_update;
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
        .respond_with(ResponseTemplate::new(200).set_body_json(manifest_json("0.20.0-cn.1")))
        .mount(&server)
        .await;
    std::env::set_var(
        "HERMES_RUNTIME_UPDATE_MANIFEST_URL",
        format!("{}/manifest.json", server.uri()),
    );

    let result = check_runtime_update().await;

    assert!(result.ok, "unexpected error: {:?}", result.error);
    let manifest = result.manifest.expect("manifest should be present");
    assert_eq!(manifest.runtime_version, "0.20.0-cn.1");
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
