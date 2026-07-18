// HTTP-boundary tests for the UI hot-update channel (Track B).
//
// check_ui_update fetches and parses a remote UI manifest and applies the
// schema / platform / downgrade / floor gates. Signature verification and disk
// install are covered by the in-module unit tests (they need a signing key and
// a zip); here we exercise the fetch + gate path against wiremock.
//
// All tests are #[serial] because they mutate HERMES_UI_UPDATE_* /
// HERMES_DESKTOP_RUNTIME_ROOT process-global env vars.

use hermes_agent_cn::process::ui_update::check_ui_update;
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

fn manifest_json(ui_version: &str, app_version_floor: &str) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "channel": "stable",
        "uiVersion": ui_version,
        "appVersionFloor": app_version_floor,
        "platform": host_platform(),
        "arch": host_arch(),
        "artifactUrl": "https://example.com/ui.zip",
        "sha256": "0".repeat(64),
        "signature": "stub-signature",
        "sourceRepo": "owner/repo",
        "sourceCommit": "abc123",
    })
}

fn clear_env() {
    for var in [
        "HERMES_UI_UPDATE_MANIFEST_URL",
        "HERMES_UI_UPDATE_BASE_URL",
        "HERMES_UI_UPDATE_CHANNEL",
        "HERMES_DESKTOP_RUNTIME_ROOT",
    ] {
        std::env::remove_var(var);
    }
}

async fn mount(server: &MockServer, body: serde_json::Value) {
    Mock::given(method("GET"))
        .and(path("/manifest.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

fn point_at(server: &MockServer) {
    std::env::set_var(
        "HERMES_UI_UPDATE_MANIFEST_URL",
        format!("{}/manifest.json", server.uri()),
    );
}

#[tokio::test]
#[serial]
async fn fresh_install_reports_update_available() {
    clear_env();
    let tmp = tempfile::TempDir::new().unwrap();
    std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());
    let server = MockServer::start().await;
    mount(&server, manifest_json("9.9.9", "0.0.1")).await;
    point_at(&server);

    let result = check_ui_update().await;

    assert!(result.ok, "unexpected error: {:?}", result.error);
    assert!(result.update_available);
    assert!(!result.floor_blocked);
    assert!(!result.downgrade_blocked);
    assert_eq!(result.manifest.unwrap().ui_version, "9.9.9");

    clear_env();
}

#[tokio::test]
#[serial]
async fn floor_above_shell_sets_floor_blocked() {
    clear_env();
    let tmp = tempfile::TempDir::new().unwrap();
    std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", tmp.path());
    let server = MockServer::start().await;
    mount(&server, manifest_json("9.9.9", "999.0.0")).await;
    point_at(&server);

    let result = check_ui_update().await;

    assert!(result.ok, "unexpected error: {:?}", result.error);
    assert!(result.floor_blocked);
    assert_eq!(result.required_app_version.as_deref(), Some("999.0.0"));

    clear_env();
}

#[tokio::test]
#[serial]
async fn wrong_schema_is_rejected() {
    clear_env();
    let mut body = manifest_json("9.9.9", "0.0.1");
    body["schemaVersion"] = serde_json::json!(2);
    let server = MockServer::start().await;
    mount(&server, body).await;
    point_at(&server);

    let result = check_ui_update().await;

    assert!(!result.ok);
    assert!(result.error.unwrap().contains("schemaVersion"));

    clear_env();
}

#[tokio::test]
#[serial]
async fn empty_floor_is_rejected() {
    clear_env();
    let server = MockServer::start().await;
    mount(&server, manifest_json("9.9.9", "")).await;
    point_at(&server);

    let result = check_ui_update().await;

    assert!(!result.ok);
    assert!(result.error.unwrap().contains("appVersionFloor"));

    clear_env();
}

#[tokio::test]
#[serial]
async fn wrong_platform_is_rejected() {
    clear_env();
    let mut body = manifest_json("9.9.9", "0.0.1");
    body["platform"] = serde_json::json!("some-other-os");
    body["arch"] = serde_json::json!("some-other-arch");
    let server = MockServer::start().await;
    mount(&server, body).await;
    point_at(&server);

    let result = check_ui_update().await;

    assert!(!result.ok);
    assert!(result.error.unwrap().contains("UI manifest is for"));

    clear_env();
}
