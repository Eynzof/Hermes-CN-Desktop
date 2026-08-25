use crate::schema::lsp::{
    LspProbeArgs, LspProcessStatus, LspShutdownArgs, LspSpawnArgs, LspWriteArgs,
};

/// Known LSP server descriptor (P1-25 breadth parity with Python
/// `agent/lsp/servers.py`). `spawn` is a `Vec<String>` because some servers
/// need an initial `--stdio` flag (tsserver) or a language id argument.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LspServerInfo {
    pub id: String,
    pub display_name: String,
    pub language_ids: Vec<String>,
    /// Default command + args. Empty when the binary is not installed yet.
    pub spawn: Vec<String>,
}

/// Static ~20-server LSP table. The actual binary may be absent; callers probe
/// with `lsp_probe_binary` before spawning.
pub fn known_lsp_servers() -> Vec<LspServerInfo> {
    vec![
        LspServerInfo {
            id: "pyright".into(),
            display_name: "Pyright (Python)".into(),
            language_ids: vec!["python".into()],
            spawn: vec!["pyright-langserver".into(), "--stdio".into()],
        },
        LspServerInfo {
            id: "tsserver".into(),
            display_name: "TypeScript".into(),
            language_ids: vec!["typescript".into(), "javascript".into()],
            spawn: vec!["typescript-language-server".into(), "--stdio".into()],
        },
        LspServerInfo {
            id: "gopls".into(),
            display_name: "gopls (Go)".into(),
            language_ids: vec!["go".into()],
            spawn: vec!["gopls".into(), "serve".into()],
        },
        LspServerInfo {
            id: "rust-analyzer".into(),
            display_name: "rust-analyzer".into(),
            language_ids: vec!["rust".into()],
            spawn: vec!["rust-analyzer".into()],
        },
        LspServerInfo {
            id: "clangd".into(),
            display_name: "clangd (C/C++)".into(),
            language_ids: vec!["c".into(), "cpp".into()],
            spawn: vec!["clangd".into()],
        },
        LspServerInfo {
            id: "jedi".into(),
            display_name: "Jedi (Python)".into(),
            language_ids: vec!["python".into()],
            spawn: vec!["jedi-language-server".into()],
        },
        LspServerInfo {
            id: "pylsp".into(),
            display_name: "python-lsp-server".into(),
            language_ids: vec!["python".into()],
            spawn: vec!["pylsp".into()],
        },
        LspServerInfo {
            id: "ruff".into(),
            display_name: "Ruff (Python)".into(),
            language_ids: vec!["python".into()],
            spawn: vec!["ruff".into(), "server".into()],
        },
        LspServerInfo {
            id: "eslint".into(),
            display_name: "ESLint".into(),
            language_ids: vec!["javascript".into(), "typescript".into()],
            spawn: vec!["vscode-eslint-language-server".into(), "--stdio".into()],
        },
        LspServerInfo {
            id: "volar".into(),
            display_name: "Volar (Vue)".into(),
            language_ids: vec!["vue".into()],
            spawn: vec!["vue-language-server".into(), "--stdio".into()],
        },
        LspServerInfo {
            id: "tailwindcss".into(),
            display_name: "Tailwind CSS".into(),
            language_ids: vec!["css".into(), "html".into()],
            spawn: vec!["tailwindcss-language-server".into(), "--stdio".into()],
        },
        LspServerInfo {
            id: "css".into(),
            display_name: "CSS".into(),
            language_ids: vec!["css".into(), "scss".into(), "less".into()],
            spawn: vec!["vscode-css-language-server".into(), "--stdio".into()],
        },
        LspServerInfo {
            id: "html".into(),
            display_name: "HTML".into(),
            language_ids: vec!["html".into()],
            spawn: vec!["vscode-html-language-server".into(), "--stdio".into()],
        },
        LspServerInfo {
            id: "json".into(),
            display_name: "JSON".into(),
            language_ids: vec!["json".into()],
            spawn: vec!["vscode-json-language-server".into(), "--stdio".into()],
        },
        LspServerInfo {
            id: "yaml".into(),
            display_name: "YAML".into(),
            language_ids: vec!["yaml".into()],
            spawn: vec!["yaml-language-server".into(), "--stdio".into()],
        },
        LspServerInfo {
            id: "terraform".into(),
            display_name: "Terraform".into(),
            language_ids: vec!["terraform".into()],
            spawn: vec!["terraform-ls".into(), "serve".into()],
        },
        LspServerInfo {
            id: "docker".into(),
            display_name: "Dockerfile".into(),
            language_ids: vec!["dockerfile".into()],
            spawn: vec!["docker-langserver".into(), "--stdio".into()],
        },
        LspServerInfo {
            id: "bash".into(),
            display_name: "Bash".into(),
            language_ids: vec!["shellscript".into()],
            spawn: vec!["bash-language-server".into(), "start".into()],
        },
        LspServerInfo {
            id: "lua".into(),
            display_name: "Lua".into(),
            language_ids: vec!["lua".into()],
            spawn: vec!["lua-language-server".into()],
        },
        LspServerInfo {
            id: "graphql".into(),
            display_name: "GraphQL".into(),
            language_ids: vec!["graphql".into()],
            spawn: vec![
                "graphql-language-service-cli".into(),
                "server".into(),
                "--method".into(),
                "stream".into(),
            ],
        },
    ]
}

/// `lsp_known_servers` — list the ~20 known LSP server descriptors.
#[tauri::command]
pub fn lsp_known_servers() -> Vec<LspServerInfo> {
    known_lsp_servers()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_servers_cover_the_core_lsp_set() {
        let servers = known_lsp_servers();
        assert!(servers.len() >= 20);
        let ids: Vec<&str> = servers.iter().map(|s| s.id.as_str()).collect();
        for required in ["pyright", "tsserver", "gopls", "rust-analyzer", "clangd"] {
            assert!(ids.contains(&required), "missing {required}");
        }
        let ts = servers.iter().find(|s| s.id == "tsserver").unwrap();
        assert_eq!(ts.spawn, vec!["typescript-language-server", "--stdio"]);
    }
}

static LSP_PROCESSES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, std::process::Child>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[tauri::command]
pub async fn lsp_spawn(args: LspSpawnArgs) -> Result<LspProcessStatus, String> {
    let mut cmd = std::process::Command::new(&args.command);
    cmd.args(&args.args).stdin(std::process::Stdio::piped());
    if let Some(cwd) = &args.cwd {
        cmd.current_dir(cwd);
    }
    let child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let key = format!("{}-{}", args.server_id, std::process::id());
    let mut map = LSP_PROCESSES.lock().map_err(|e| e.to_string())?;
    map.insert(key.clone(), child);
    Ok(LspProcessStatus {
        process_key: key,
        alive: true,
    })
}

#[tauri::command]
pub async fn lsp_write_stdin(args: LspWriteArgs) -> Result<(), String> {
    use base64::Engine;
    let mut map = LSP_PROCESSES.lock().map_err(|e| e.to_string())?;
    let child = map
        .get_mut(&args.process_key)
        .ok_or_else(|| "unknown process".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&args.bytes_base64)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "stdin closed".to_string())?;
    stdin.write_all(&bytes).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn lsp_shutdown(args: LspShutdownArgs) -> Result<(), String> {
    let mut map = LSP_PROCESSES.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = map.remove(&args.process_key) {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_probe_binary(args: LspProbeArgs) -> Result<bool, String> {
    // v1: best-effort probe via `command --version` without external crates.
    let output = std::process::Command::new(&args.name)
        .arg("--version")
        .output();
    Ok(output.is_ok())
}

#[tauri::command]
pub async fn lsp_status() -> Result<Vec<LspProcessStatus>, String> {
    let mut map = LSP_PROCESSES.lock().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (key, child) in map.iter_mut() {
        out.push(LspProcessStatus {
            process_key: key.clone(),
            alive: child.try_wait().map(|o| o.is_none()).unwrap_or(false),
        });
    }
    Ok(out)
}
