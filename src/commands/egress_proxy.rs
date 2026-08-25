use crate::schema::egress::{
    EgressProxyDownloadArgs, EgressProxyImportSecretsArgs, EgressProxyRule,
    EgressProxySetRulesArgs, EgressProxyStartArgs, EgressProxyStatus,
};

static EGRESS_PORT: std::sync::Mutex<Option<u16>> = std::sync::Mutex::new(None);
static SECRETS: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

// ---------------------------------------------------------------------------
// Secrets sources (P1-20): env / Bitwarden Secrets Manager / 1Password CLI /
// command. Real resolution delegates to the installed CLI; the resolver is a
// pure function so tests can exercise the env + unknown-source paths without
// a password manager installed.
// ---------------------------------------------------------------------------

/// Run a CLI and return trimmed stdout.
fn run_cli(args: &[&str]) -> Result<String, String> {
    let (program, rest) = args
        .split_first()
        .ok_or_else(|| "empty CLI command".to_string())?;
    let output = std::process::Command::new(program)
        .args(rest)
        .output()
        .map_err(|e| format!("failed to run {program}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} exited with {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Resolve a secret from a configured source.
///
/// - `env`: `key` is read from the process environment.
/// - `bitwarden`: `key` is the Bitwarden Secrets Manager secret id/name;
///   resolved via `bw get secret <key>`.
/// - `onepassword`: `value` is a 1Password CLI reference (`op://vault/item/field`);
///   resolved via `op read <value>`.
/// - `command`: `value` is a shell command whose trimmed stdout is the secret.
pub fn resolve_secret_source(source: &str, key: &str, value: &str) -> Result<String, String> {
    match source {
        "env" => std::env::var(key).map_err(|_| format!("env var {key} is not set")),
        "bitwarden" => run_cli(&["bw", "get", "secret", key]),
        "onepassword" => run_cli(&["op", "read", value]),
        "command" => run_cli(&["sh", "-c", value]),
        other => Err(format!(
            "unknown secret source '{other}' (expected env|bitwarden|onepassword|command)"
        )),
    }
}

/// `egress_proxy_resolve_secret` — resolve a single secret from a source
/// without storing it (the proxy stores resolved secrets only after import).
#[tauri::command]
pub fn egress_proxy_resolve_secret(
    source: String,
    key: String,
    value: String,
) -> Result<String, String> {
    resolve_secret_source(&source, &key, &value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_source_reads_process_environment() {
        std::env::set_var("EGRESS_PROXY_TEST_SECRET", "top-secret");
        let resolved = resolve_secret_source("env", "EGRESS_PROXY_TEST_SECRET", "");
        std::env::remove_var("EGRESS_PROXY_TEST_SECRET");
        assert_eq!(resolved.as_deref(), Ok("top-secret"));
    }

    #[test]
    fn env_source_missing_var_is_an_error() {
        let err = resolve_secret_source("env", "DEFINITELY_NOT_SET_12345", "").unwrap_err();
        assert!(err.contains("is not set"));
    }

    #[test]
    fn unknown_source_is_rejected() {
        let err = resolve_secret_source("vault", "k", "v").unwrap_err();
        assert!(err.contains("unknown secret source"));
    }
}

#[tauri::command]
pub async fn egress_proxy_start(args: EgressProxyStartArgs) -> Result<EgressProxyStatus, String> {
    let port = args.port.unwrap_or(8650);
    let mut p = EGRESS_PORT.lock().map_err(|e| e.to_string())?;
    *p = Some(port);
    Ok(EgressProxyStatus {
        running: true,
        port: Some(port),
        rules: vec![],
    })
}

#[tauri::command]
pub async fn egress_proxy_stop() -> Result<(), String> {
    let mut p = EGRESS_PORT.lock().map_err(|e| e.to_string())?;
    *p = None;
    Ok(())
}

#[tauri::command]
pub async fn egress_proxy_status() -> Result<EgressProxyStatus, String> {
    let p = EGRESS_PORT.lock().map_err(|e| e.to_string())?;
    Ok(EgressProxyStatus {
        running: p.is_some(),
        port: *p,
        rules: vec![],
    })
}

#[tauri::command]
pub async fn egress_proxy_set_rules(
    args: EgressProxySetRulesArgs,
) -> Result<EgressProxyStatus, String> {
    let parsed: Vec<EgressProxyRule> =
        serde_json::from_str(&args.rules_json).map_err(|e| e.to_string())?;
    let status = egress_proxy_status().await?;
    Ok(EgressProxyStatus {
        running: status.running,
        port: status.port,
        rules: parsed,
    })
}

#[tauri::command]
pub async fn egress_proxy_download(args: EgressProxyDownloadArgs) -> Result<String, String> {
    // v1 stub: echo back a JSON rule pack so the orchestrator can continue without real network access.
    Ok(format!("{{\"url\":\"{}\",\"rules\":[]}}", args.url))
}

#[tauri::command]
pub async fn egress_proxy_import_secrets(
    args: EgressProxyImportSecretsArgs,
) -> Result<serde_json::Value, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(&args.secrets_json).map_err(|e| e.to_string())?;
    let mut s = SECRETS.lock().map_err(|e| e.to_string())?;
    *s = Some(parsed.clone());
    Ok(serde_json::json!({ "secrets": parsed, "importedAt": chrono::Utc::now().to_rfc3339() }))
}

#[tauri::command]
pub async fn egress_proxy_export_secrets() -> Result<serde_json::Value, String> {
    let s = SECRETS.lock().map_err(|e| e.to_string())?;
    let secrets = s.clone().unwrap_or(serde_json::json!({}));
    Ok(secrets)
}
