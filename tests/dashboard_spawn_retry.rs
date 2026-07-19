//! Spawn-retry integration tests: drive `ensure_hermes_dashboard` against a
//! fake managed runtime (a shell script recorded in `current.json`) and
//! assert the readiness state machine's behavior end to end — no real
//! backend, no network beyond loopback probes of unbound ports.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use hermes_agent_cn::connection::ConnectionMode;
use hermes_agent_cn::process::dashboard::{ensure_hermes_dashboard, EnsureDashboardOptions};
use hermes_agent_cn::process::runtime::RuntimeInstallRecord;
use serial_test::serial;

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
    listener.local_addr().expect("local addr").port()
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn current_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

/// Install a fake runtime whose "kernel" is the given shell script body.
fn install_fake_runtime(root: &Path, script_body: &str) {
    let script = root.join("fake-hermes.sh");
    std::fs::write(&script, script_body).expect("write fake runtime script");
    let mut perms = std::fs::metadata(&script)
        .expect("script metadata")
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&script, perms).expect("chmod script");

    let record = RuntimeInstallRecord {
        schema_version: 2,
        runtime_version: "0.0.0-test".to_string(),
        kernel_version: "0.0.0-test".to_string(),
        runtime_flavor: "test".to_string(),
        runtime_revision: 1,
        platform: current_platform().to_string(),
        arch: current_arch().to_string(),
        path: root.to_string_lossy().to_string(),
        executable_path: script.to_string_lossy().to_string(),
        source: "test".to_string(),
        installed_at: "1970-01-01T00:00:00Z".to_string(),
        source_repo: None,
        source_commit: None,
        local_dirty_hash: None,
        artifact_sha256: None,
        previous_runtime_version: None,
    };
    std::fs::write(
        root.join("current.json"),
        serde_json::to_string_pretty(&record).expect("serialize record"),
    )
    .expect("write current.json");
}

fn ready_file_leftovers(root: &Path) -> Vec<String> {
    std::fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|name| name.starts_with("dashboard-ready-"))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
#[serial]
async fn crash_looping_runtime_retries_then_fails_cleanly() {
    let runtime = tempfile::TempDir::new().expect("runtime root");
    std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", runtime.path());
    let home = runtime.path().join("hermes-home");
    std::fs::create_dir_all(&home).expect("home");

    // A kernel that dies immediately — models the port-bind OSError exit.
    install_fake_runtime(runtime.path(), "#!/bin/sh\nexit 7\n");

    let result = ensure_hermes_dashboard(EnsureDashboardOptions {
        host: "127.0.0.1".to_string(),
        port: free_port(),
        hermes_home: home.to_string_lossy().to_string(),
        allow_external_agent: false,
        allow_port_fallback: true,
        connection_mode: ConnectionMode::Managed,
        remote_base_url: None,
    })
    .await;
    let err = match result {
        Ok(_) => panic!("crash-looping runtime must not become ready"),
        Err(err) => err.to_string(),
    };

    assert!(
        err.contains("attempt"),
        "error should mention bounded attempts: {err}"
    );
    assert!(
        err.contains("exited before ready"),
        "error should carry the child-exit reason: {err}"
    );
    assert!(
        ready_file_leftovers(runtime.path()).is_empty(),
        "failed spawns must not leak ready files"
    );
    assert!(
        !runtime.path().join("desktop-owner.json").exists(),
        "failed spawns must not leak ownership markers"
    );
    std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
}

#[tokio::test]
#[serial]
async fn ready_file_completes_spawn_without_http() {
    let runtime = tempfile::TempDir::new().expect("runtime root");
    std::env::set_var("HERMES_DESKTOP_RUNTIME_ROOT", runtime.path());
    let home = runtime.path().join("hermes-home");
    std::fs::create_dir_all(&home).expect("home");

    // A kernel that never serves HTTP but writes the ready file exactly like
    // Core's _write_dashboard_ready_file — proving the identity channel alone
    // completes the wait. argv: dashboard --host H --port P --no-open → $5.
    install_fake_runtime(
        runtime.path(),
        "#!/bin/sh\nprintf '{\"port\": %s}' \"$5\" > \"$HERMES_DESKTOP_READY_FILE\"\nsleep 30\n",
    );

    let port = free_port();
    let mut handle = ensure_hermes_dashboard(EnsureDashboardOptions {
        host: "127.0.0.1".to_string(),
        port,
        hermes_home: home.to_string_lossy().to_string(),
        allow_external_agent: false,
        allow_port_fallback: true,
        connection_mode: ConnectionMode::Managed,
        remote_base_url: None,
    })
    .await
    .expect("ready file must complete the spawn");

    assert_eq!(handle.api_base_url, format!("http://127.0.0.1:{port}"));
    assert_eq!(handle.ownership_state.as_deref(), Some("owned"));
    assert!(handle.owns_process);
    assert!(
        handle.session_token.is_some(),
        "spawn must mint a session token"
    );
    assert!(
        ready_file_leftovers(runtime.path()).is_empty(),
        "consumed ready file must be deleted"
    );

    // Reap the fake kernel so the sleep doesn't outlive the test.
    if let Some(mut child) = handle.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    std::env::remove_var("HERMES_DESKTOP_RUNTIME_ROOT");
}
