//! Dummy-server end-to-end verification of the UI hot-update track (path B).
//!
//! This is the runnable form of the "本地验证（dummy server）" usage in
//! `docs/hot-update.md` §8.2: no real release is uploaded anywhere, so we
//! 1. build/zip a web dist (real `web/dist` via `HOT_UPDATE_TEST_DIST`, or a
//!    built-in minimal fixture),
//! 2. generate a throwaway Ed25519 keypair,
//! 3. sign the 10-field UI manifest,
//! 4. serve manifest + zip over a REAL local HTTP server (127.0.0.1),
//! 5. run the actual `check_ui_update` / `install_ui_update` / `rollback_ui_update`
//!    and assert the install tree, `current.json` and the rollback pointer.
//!
//! Environment (all optional):
//!   HERMES_DESKTOP_RUNTIME_ROOT   — where the `ui/` tree is created (default: temp)
//!   HOT_UPDATE_TEST_DIST          — directory to zip as the "new UI"; default is a
//!                                   minimal Vite-shaped fixture. Set to `web/dist`
//!                                   to verify against the real built artifact.
//!   HOT_UPDATE_SKIP_RUN           — set to `1` to skip the network phase (CI gate).
//!
//! Everything binds to 127.0.0.1 only — no external network is touched.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use ed25519_dalek::pkcs8::EncodePublicKey;
use ed25519_dalek::{Signer, SigningKey};
use pretty_assertions::assert_eq;
use sha2::{Digest, Sha256};

use hermes_agent_cn::process::ui_update::{
    check_ui_update, install_ui_update, rollback_ui_update, ui_serving_version_dir,
    UiInstallUpdateResult, UiUpdateManifest,
};

// ─────────────────────────── platform helpers ───────────────────────────────

/// Mirror of `runtime.rs` `current_platform()` (pub(crate) there, so recomputed
/// here — must stay in lockstep with the manifest the client will validate).
fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// Mirror of `runtime.rs` `current_arch()`.
fn current_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

// ─────────────────────────── web-dist packaging ─────────────────────────────

/// Recursively zip `src_dir` (entries relative to it) into `zip_path`.
fn zip_dir(src_dir: &Path, zip_path: &Path) -> Vec<u8> {
    let file = std::fs::File::create(zip_path).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();

    fn walk(
        writer: &mut zip::ZipWriter<std::fs::File>,
        dir: &Path,
        base: &Path,
        options: zip::write::SimpleFileOptions,
    ) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap())
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let rel = path.strip_prefix(base).unwrap();
            if path.is_dir() {
                walk(writer, &path, base, options);
            } else {
                let name = rel.to_string_lossy().replace('\\', "/");
                writer.start_file(name, options).unwrap();
                let mut file = std::fs::File::open(&path).unwrap();
                let mut buf = Vec::new();
                file.read_to_end(&mut buf).unwrap();
                writer.write_all(&buf).unwrap();
            }
        }
    }

    walk(&mut writer, src_dir, src_dir, options);
    writer.finish().unwrap();
    std::fs::read(zip_path).unwrap()
}

/// Resolve the dist to zip: `HOT_UPDATE_TEST_DIST` when set (the real built
/// `web/dist`), otherwise a minimal Vite-shaped fixture written under `root`.
fn resolve_dist(root: &Path) -> PathBuf {
    if let Ok(dir) = std::env::var("HOT_UPDATE_TEST_DIST") {
        let dir = PathBuf::from(dir.trim());
        assert!(
            dir.is_dir(),
            "HOT_UPDATE_TEST_DIST is not a directory: {}",
            dir.display()
        );
        assert!(
            dir.join("index.html").is_file(),
            "HOT_UPDATE_TEST_DIST has no index.html"
        );
        return dir;
    }
    let fixture = root.join("fixture-dist");
    std::fs::create_dir_all(fixture.join("assets")).unwrap();
    std::fs::write(
        fixture.join("index.html"),
        "<!doctype html><html><head></head><body>\
         <script type=\"module\" crossorigin src=\"/assets/app-dummyserver.js\"></script>\
         </body></html>",
    )
    .unwrap();
    std::fs::write(
        fixture.join("assets/app-dummyserver.js"),
        "console.log('dummy');\n",
    )
    .unwrap();
    fixture
}

// ─────────────────────────── manifest signing ───────────────────────────────

/// Recompute the exact 10-field signed payload (order is load-bearing; must
/// match `ui_signature_payload` in src/process/ui_update.rs).
fn ui_payload(m: &UiUpdateManifest) -> Vec<u8> {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        m.schema_version,
        m.channel,
        m.ui_version,
        m.app_version_floor,
        m.platform,
        m.arch,
        m.artifact_url,
        m.sha256,
        m.source_repo,
        m.source_commit,
    )
    .into_bytes()
}

fn sign_ui_manifest(key: &SigningKey, manifest: &mut UiUpdateManifest) {
    let sig = key.sign(&ui_payload(manifest));
    manifest.signature = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
}

// ─────────────────────────── dummy HTTP server ──────────────────────────────

/// Minimal real HTTP/1.1 server on 127.0.0.1: serves pre-registered
/// path → bytes. Used instead of a mock library so the test exercises the
/// exact wire behaviour a real (dummy) distribution server would have.
struct DummyServer {
    base_url: String,
    port: u16,
    routes: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl DummyServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind dummy server");
        let port = listener.local_addr().unwrap().port();
        let routes = Arc::new(Mutex::new(HashMap::new()));
        let routes_thread = Arc::clone(&routes);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        let thread = std::thread::spawn(move || {
            listener.set_nonblocking(true).ok();
            let mut connections: Vec<TcpStream> = Vec::new();
            loop {
                if stop_thread.load(Ordering::SeqCst) {
                    break;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(true).ok();
                        connections.push(stream);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => break,
                }
                // Drain any readable connections one at a time.
                let mut i = 0;
                while i < connections.len() {
                    let mut stream = connections.remove(i);
                    match serve_one(&mut stream, &routes_thread) {
                        ServeResult::Done => {}
                        ServeResult::WouldBlock => {
                            connections.push(stream);
                            i += 1;
                        }
                        ServeResult::Error => {}
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        DummyServer {
            base_url: format!("http://127.0.0.1:{port}"),
            port,
            routes,
            stop,
            thread: Some(thread),
        }
    }

    fn set_route(&self, path: &str, body: Vec<u8>) {
        self.routes.lock().unwrap().insert(path.to_string(), body);
    }

    fn set_manifest(&self, manifest: &UiUpdateManifest) {
        self.set_route("/ui/manifest.json", serde_json::to_vec(manifest).unwrap());
    }
}

enum ServeResult {
    Done,
    WouldBlock,
    Error,
}

fn serve_one(stream: &mut TcpStream, routes: &Arc<Mutex<HashMap<String, Vec<u8>>>>) -> ServeResult {
    let mut buf = [0u8; 2048];
    let n = match stream.read(&mut buf) {
        Ok(0) => return ServeResult::Done,
        Ok(n) => n,
        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => return ServeResult::WouldBlock,
        Err(_) => return ServeResult::Error,
    };
    let request = String::from_utf8_lossy(&buf[..n]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_string();
    let body = routes
        .lock()
        .unwrap()
        .get(&path)
        .cloned()
        .unwrap_or_default();
    let status = if body.is_empty() {
        "404 Not Found"
    } else {
        "200 OK"
    };
    let content_type = if path.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(&body);
    let _ = stream.flush();
    ServeResult::Done
}

impl Drop for DummyServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Unblock accept() so the thread can observe the flag.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

// ─────────────────────────── env helpers ────────────────────────────────────

fn set_env(key: &str, value: &str) {
    std::env::set_var(key, value);
}

fn restore_env(key: &str, prev: Option<String>) {
    match prev {
        Some(v) => std::env::set_var(key, v),
        None => std::env::remove_var(key),
    }
}

fn read_current_json(root: &Path) -> serde_json::Value {
    let path = root.join("ui").join("current.json");
    let text = std::fs::read_to_string(&path).expect("ui/current.json exists");
    serde_json::from_str(&text).unwrap()
}

// ─────────────────────────────── test ───────────────────────────────────────

#[test]
fn ui_hot_update_against_dummy_server() {
    if std::env::var("HOT_UPDATE_SKIP_RUN").is_ok() {
        eprintln!("[hot_update_dummy_server] HOT_UPDATE_SKIP_RUN set — skipping network phase");
        return;
    }

    // -- env isolation -------------------------------------------------------
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().to_path_buf();
    let prev_root = std::env::var("HERMES_DESKTOP_RUNTIME_ROOT").ok();
    let prev_key = std::env::var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM").ok();
    let prev_manifest = std::env::var("HERMES_UI_UPDATE_MANIFEST_URL").ok();
    let prev_http = std::env::var("HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT").ok();
    set_env("HERMES_DESKTOP_RUNTIME_ROOT", &root.to_string_lossy());
    set_env("HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT", "1");

    // -- throwaway keypair (deterministic seed, like the unit tests) ---------
    let key = SigningKey::from_bytes(&[42u8; 32]);
    let public_key_pem = key
        .verifying_key()
        .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
        .unwrap();
    set_env("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", &public_key_pem);

    // -- dist + zips ---------------------------------------------------------
    let dist = resolve_dist(&root);
    let artifacts = root.join("artifacts");
    std::fs::create_dir_all(&artifacts).unwrap();
    let zip_070 = zip_dir(&dist, &artifacts.join("ui-0.7.0.zip"));
    let zip_071 = zip_dir(&dist, &artifacts.join("ui-0.7.1.zip"));

    // -- dummy server --------------------------------------------------------
    let server = DummyServer::start();
    let base = server.base_url.clone();
    set_env(
        "HERMES_UI_UPDATE_MANIFEST_URL",
        &format!("{base}/ui/manifest.json"),
    );
    server.set_route("/artifacts/ui-0.7.0.zip", zip_070.clone());
    server.set_route("/artifacts/ui-0.7.1.zip", zip_071.clone());

    let manifest_for = |ui_version: &str, zip: &[u8]| -> UiUpdateManifest {
        UiUpdateManifest {
            schema_version: 1,
            channel: "stable".to_string(),
            ui_version: ui_version.to_string(),
            app_version_floor: "0.0.1".to_string(),
            platform: current_platform().to_string(),
            arch: current_arch().to_string(),
            artifact_url: format!("{base}/artifacts/ui-{ui_version}.zip"),
            sha256: sha256_hex(zip),
            signature: String::new(),
            source_repo: "Eynzof/Hermes-CN-Desktop".to_string(),
            source_commit: "dummy".to_string(),
        }
    };

    // -- phase 1: check + install 0.7.0 --------------------------------------
    let mut m070 = manifest_for("0.7.0", &zip_070);
    sign_ui_manifest(&key, &mut m070);
    server.set_manifest(&m070);

    let check = {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(check_ui_update())
    };
    assert!(check.ok, "check failed: {:?}", check.error);
    assert!(check.update_available, "no update reported");
    assert_eq!(check.manifest.as_ref().unwrap().ui_version, "0.7.0");

    let install = {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(install_ui_update())
    };
    assert!(install.ok, "install 0.7.0 failed: {:?}", install.error);
    let installed = install.installed.as_ref().unwrap();
    assert_eq!(installed.ui_version, "0.7.0");
    assert_eq!(installed.previous_ui_version, None);
    assert!(root.join("ui/versions/0.7.0/index.html").is_file());
    assert!(root.join("ui/versions/0.7.0/manifest.json").is_file());
    let current = read_current_json(&root);
    assert_eq!(current["uiVersion"], "0.7.0");
    // The serving dir must resolve to the freshly installed version.
    let serving = ui_serving_version_dir().expect("a hot UI is servable");
    assert!(
        serving.ends_with("0.7.0"),
        "serving dir: {}",
        serving.display()
    );

    // -- phase 2: upgrade to 0.7.1 (records the previous) --------------------
    let mut m071 = manifest_for("0.7.1", &zip_071);
    sign_ui_manifest(&key, &mut m071);
    server.set_manifest(&m071);

    let install2 = {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(install_ui_update())
    };
    assert!(install2.ok, "install 0.7.1 failed: {:?}", install2.error);
    let installed2 = install2.installed.as_ref().unwrap();
    assert_eq!(installed2.ui_version, "0.7.1");
    assert_eq!(installed2.previous_ui_version.as_deref(), Some("0.7.0"));
    let current2 = read_current_json(&root);
    assert_eq!(current2["uiVersion"], "0.7.1");
    assert_eq!(current2["previousUiVersion"], "0.7.0");

    // -- phase 3: rollback to 0.7.0 (no network) ------------------------------
    let rollback: UiInstallUpdateResult = rollback_ui_update();
    assert!(rollback.ok, "rollback failed: {:?}", rollback.error);
    assert_eq!(rollback.installed.as_ref().unwrap().ui_version, "0.7.0");
    let current3 = read_current_json(&root);
    assert_eq!(current3["uiVersion"], "0.7.0");
    assert_eq!(current3["previousUiVersion"], "0.7.1");
    assert!(root.join("ui/versions/0.7.0/index.html").is_file());

    // -- restore env ----------------------------------------------------------
    restore_env("HERMES_DESKTOP_RUNTIME_ROOT", prev_root);
    restore_env("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM", prev_key);
    restore_env("HERMES_UI_UPDATE_MANIFEST_URL", prev_manifest);
    restore_env("HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT", prev_http);
}
