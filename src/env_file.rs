// Per-spawn injection of the user's `$HERMES_HOME/.env` into managed child
// processes (dashboard, IM gateway).
//
// The desktop process never loads `.env` into its own environment: mutating
// process env via `std::env::set_var` is unsound once threads are running
// (Tauri spawns several before `setup`), and a process-global load would
// leak one profile's secrets into the next — profile switches respawn the
// dashboard but the desktop process itself survives. Instead, each spawn
// site reads the `.env` that belongs to the child's HERMES_HOME and passes
// the pairs through `Command::envs`, so values are re-read on every respawn
// (profile switch, YOLO toggle, runtime update) and stay scoped to the
// right profile. See issue #197.
//
// The backend re-loads the same file with override semantics at every
// entrypoint (`load_hermes_dotenv` in cli.py / run_agent.py /
// tui_gateway/server.py), so for current runtimes this injection is
// belt-and-braces; it guarantees user-configured variables reach children
// even on runtime builds whose entrypoints skip that load.

use std::path::Path;
use std::process::Command;

/// Keys the desktop wires explicitly on child spawns. `.env` contents must
/// never rewire them, no matter where the injection call sits relative to
/// the explicit `.env(...)` calls. `HERMES_YOLO_MODE` in particular is a
/// security gate driven only by the persisted desktop preference, and
/// `PATH` decides which executables the child resolves.
const RESERVED_KEYS: &[&str] = &[
    "HERMES_HOME",
    "HERMES_YOLO_MODE",
    "HERMES_DASHBOARD_SESSION_TOKEN",
    "HERMES_DASHBOARD_TUI",
    "HERMES_DASHBOARD_PREWARM_AGENT",
    "HERMES_DISABLE_LAZY_INSTALLS",
    "HERMES_WEB_DIST",
    "HERMES_BUNDLED_SKILLS",
    "HERMES_BUNDLED_PLUGINS",
    "HERMES_GATEWAY_LOCK_DIR",
    "HERMES_GATEWAY_RUNTIME_DIR",
    "HERMES_GATEWAY_DETACHED",
    "HERMES_NONINTERACTIVE",
    "PYTHONUNBUFFERED",
    "PATH",
];

/// `HERMES_DESKTOP_*` configures the desktop shell itself (API host/port,
/// bootstrap mode). Children ignore these, and letting a runtime `.env`
/// masquerade as desktop configuration would only confuse diagnostics.
const RESERVED_PREFIX: &str = "HERMES_DESKTOP_";

fn is_reserved(key: &str) -> bool {
    RESERVED_KEYS.contains(&key) || key.starts_with(RESERVED_PREFIX)
}

/// Read `$hermes_home/.env` without touching the desktop process
/// environment. Returns pairs in file order (later duplicates win once
/// applied to a `Command` env map, matching python-dotenv). Missing file
/// yields an empty list; a parse error stops reading at the offending line
/// and everything before it is still returned.
pub fn read_env_file_vars(hermes_home: &str) -> Vec<(String, String)> {
    let path = Path::new(hermes_home).join(".env");
    if !path.is_file() {
        return Vec::new();
    }
    let iter = match dotenvy::from_path_iter(&path) {
        Ok(iter) => iter,
        Err(err) => {
            log::warn!("Failed to read {}: {}", path.display(), err);
            return Vec::new();
        }
    };

    let mut vars: Vec<(String, String)> = Vec::new();
    for item in iter {
        match item {
            Ok((key, value)) => {
                if is_reserved(&key) {
                    log::warn!(
                        "Ignoring desktop-reserved key {} in {}",
                        key,
                        path.display()
                    );
                    continue;
                }
                // Embedded NUL would fail the entire spawn with
                // InvalidInput; the backend sanitizes these on its own
                // load, so just skip the broken entry here.
                if key.contains('\0') || value.contains('\0') {
                    log::warn!(
                        "Ignoring key {} in {}: embedded NUL in value",
                        key,
                        path.display()
                    );
                    continue;
                }
                vars.push((key, value));
            }
            Err(err) => {
                log::warn!(
                    "Stopped reading {} after {} vars: {}",
                    path.display(),
                    vars.len(),
                    err
                );
                break;
            }
        }
    }
    vars
}

/// Inject the child-HERMES_HOME's `.env` into `cmd`. Call before the
/// explicit `.env(...)` wiring so desktop-controlled keys win even if a
/// future key is missing from `RESERVED_KEYS`.
pub fn inject_env_file(cmd: &mut Command, hermes_home: &str, child: &str) {
    let vars = read_env_file_vars(hermes_home);
    if vars.is_empty() {
        return;
    }
    log::info!(
        "Injecting {} env vars from {} into {} spawn",
        vars.len(),
        Path::new(hermes_home).join(".env").display(),
        child
    );
    cmd.envs(vars);
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::ffi::OsStr;
    use std::fs;
    use tempfile::TempDir;

    fn home_with_env(content: &str) -> TempDir {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(".env"), content).unwrap();
        dir
    }

    fn read(dir: &TempDir) -> Vec<(String, String)> {
        read_env_file_vars(dir.path().to_str().unwrap())
    }

    #[test]
    fn missing_env_file_yields_empty() {
        let dir = TempDir::new().unwrap();
        assert_eq!(read(&dir), Vec::new());
    }

    #[test]
    fn parses_comments_quotes_and_export_prefix() {
        let dir = home_with_env(
            "# providers\nTAVILY_API_KEY=tvly-abc\nOPENAI_API_KEY=\"sk-quoted\"\nexport BRAVE_SEARCH_API_KEY='single'\n",
        );
        assert_eq!(
            read(&dir),
            vec![
                ("TAVILY_API_KEY".into(), "tvly-abc".into()),
                ("OPENAI_API_KEY".into(), "sk-quoted".into()),
                ("BRAVE_SEARCH_API_KEY".into(), "single".into()),
            ]
        );
    }

    #[test]
    fn filters_desktop_reserved_keys() {
        let dir = home_with_env(
            "HERMES_YOLO_MODE=1\nHERMES_HOME=/elsewhere\nHERMES_DESKTOP_API_PORT=9119\nPATH=/evil\nTAVILY_API_KEY=ok\n",
        );
        assert_eq!(read(&dir), vec![("TAVILY_API_KEY".into(), "ok".into())]);
    }

    #[test]
    fn parse_error_keeps_earlier_vars() {
        let dir = home_with_env("TAVILY_API_KEY=ok\n%%% not an env line\nLATER_KEY=lost\n");
        assert_eq!(read(&dir), vec![("TAVILY_API_KEY".into(), "ok".into())]);
    }

    #[test]
    fn skips_values_with_embedded_nul() {
        let dir = home_with_env("BROKEN_API_KEY=\"a\u{0}b\"\nTAVILY_API_KEY=ok\n");
        assert_eq!(read(&dir), vec![("TAVILY_API_KEY".into(), "ok".into())]);
    }

    #[test]
    fn explicit_desktop_env_wins_over_injection() {
        let dir = home_with_env("TAVILY_API_KEY=from-file\nFEISHU_APP_ID=cli_x\n");
        let mut cmd = Command::new("true");
        inject_env_file(&mut cmd, dir.path().to_str().unwrap(), "test");
        cmd.env("FEISHU_APP_ID", "cli_explicit");

        let envs: Vec<(&OsStr, Option<&OsStr>)> = cmd.get_envs().collect();
        assert_eq!(
            envs,
            vec![
                (
                    OsStr::new("FEISHU_APP_ID"),
                    Some(OsStr::new("cli_explicit"))
                ),
                (OsStr::new("TAVILY_API_KEY"), Some(OsStr::new("from-file"))),
            ]
        );
    }
}
