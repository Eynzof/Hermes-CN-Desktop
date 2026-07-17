//! 编码代理 CLI（Claude Code / Codex）的深度检测：安装状态、版本、登录态。
//!
//! 与 environment.rs 的声明式工具体检互补：那边只做 PATH 快检行，这里为
//! 「编码代理」设置页提供更完整的状态——覆盖 PATH 之外的常见安装点
//! （~/.claude/local/claude、~/.local/bin），并探测登录态（凭据文件优先，
//! macOS 兜底查钥匙串条目的存在性）。
//!
//! 隐私边界：登录态探测**绝不读取 token 密文**——凭据文件只解析
//! `claudeAiOauth.expiresAt` 等元数据字段；macOS `security` 查询不带 `-w`
//! （只确认条目存在，不导出密码，也不会触发钥匙串 ACL 授权弹窗）。

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::environment::{now_ms, probe_commands};

pub const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
pub const CODEX_KEYCHAIN_SERVICE: &str = "Codex Auth";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodingAgentLoginState {
    LoggedIn,
    Expired,
    NotLoggedIn,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingAgentStatus {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub login_state: CodingAgentLoginState,
    /// 人话补充（过期时间、凭据位置等），不含任何秘密。
    pub login_detail: Option<String>,
    pub config_dir: String,
    /// hermes 侧对应的委派技能名（用于设置页联动技能开关）。
    pub skill_name: String,
    pub install_hint: String,
    pub login_hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingAgentsCheckResult {
    pub generated_at_ms: u64,
    pub platform: String,
    pub agents: Vec<CodingAgentStatus>,
}

// ── 纯函数（单测覆盖） ────────────────────────────────────────────────────

/// Claude Code 配置目录：CLAUDE_CONFIG_DIR 显式优先，否则 ~/.claude。
pub(crate) fn claude_config_dir(env_override: Option<&str>, home: &Path) -> PathBuf {
    match env_override.map(str::trim) {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => home.join(".claude"),
    }
}

/// Codex 配置目录：CODEX_HOME 显式优先，否则 ~/.codex。
pub(crate) fn codex_config_dir(env_override: Option<&str>, home: &Path) -> PathBuf {
    match env_override.map(str::trim) {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => home.join(".codex"),
    }
}

/// 解析 ~/.claude/.credentials.json（只读元数据字段，不触碰 token 本体）。
pub(crate) fn parse_claude_credentials(
    raw: &str,
    now_ms: u64,
) -> (CodingAgentLoginState, Option<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (
            CodingAgentLoginState::Unknown,
            Some("凭据文件无法解析".into()),
        );
    };
    let oauth = value
        .get("claudeAiOauth")
        .or_else(|| value.get("claude.ai_oauth"));
    let Some(oauth) = oauth else {
        return (
            CodingAgentLoginState::Unknown,
            Some("凭据文件存在但格式未知".into()),
        );
    };
    match oauth.get("expiresAt").and_then(serde_json::Value::as_u64) {
        Some(expires_at) if expires_at > now_ms => {
            let remain_h = (expires_at - now_ms) / 3_600_000;
            (
                CodingAgentLoginState::LoggedIn,
                Some(format!(
                    "OAuth 凭据有效（约 {remain_h} 小时后过期，可自动刷新）"
                )),
            )
        }
        Some(_) => (
            CodingAgentLoginState::Expired,
            Some("OAuth 凭据已过期，运行 claude 重新登录".into()),
        ),
        None => (
            CodingAgentLoginState::LoggedIn,
            Some("发现 OAuth 凭据（未含过期时间）".into()),
        ),
    }
}

/// 解析 ~/.codex/auth.json：OPENAI_API_KEY 或 tokens 任一存在即视为已登录。
pub(crate) fn parse_codex_auth(raw: &str) -> (CodingAgentLoginState, Option<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (
            CodingAgentLoginState::Unknown,
            Some("auth.json 无法解析".into()),
        );
    };
    let has_api_key = value
        .get("OPENAI_API_KEY")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    let has_tokens = value.get("tokens").is_some_and(|t| !t.is_null());
    if has_api_key || has_tokens {
        let detail = if has_tokens {
            "已通过 ChatGPT 账号登录"
        } else {
            "已配置 API Key"
        };
        (CodingAgentLoginState::LoggedIn, Some(detail.into()))
    } else {
        (
            CodingAgentLoginState::NotLoggedIn,
            Some("auth.json 存在但没有可用凭据".into()),
        )
    }
}

/// macOS 钥匙串条目存在性检查（不带 -w：不读密文、不触发 ACL 弹窗）。
/// 非 macOS 或执行失败返回 None（调用方归 Unknown/NotLoggedIn）。
fn keychain_entry_exists(service: &str) -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("security")
            .args(["find-generic-password", "-s", service])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        match output {
            Ok(status) => Some(status.success()),
            Err(_) => None,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = service;
        None
    }
}

fn detect_claude_login(config_dir: &Path) -> (CodingAgentLoginState, Option<String>) {
    let creds = config_dir.join(".credentials.json");
    if let Ok(raw) = std::fs::read_to_string(&creds) {
        return parse_claude_credentials(&raw, now_ms());
    }
    match keychain_entry_exists(CLAUDE_KEYCHAIN_SERVICE) {
        Some(true) => (
            CodingAgentLoginState::LoggedIn,
            Some("凭据保存在系统钥匙串".into()),
        ),
        Some(false) => (
            CodingAgentLoginState::NotLoggedIn,
            Some("未发现登录凭据（如使用 API Key 环境变量可忽略）".into()),
        ),
        None => (CodingAgentLoginState::Unknown, None),
    }
}

fn detect_codex_login(config_dir: &Path) -> (CodingAgentLoginState, Option<String>) {
    let auth = config_dir.join("auth.json");
    if let Ok(raw) = std::fs::read_to_string(&auth) {
        return parse_codex_auth(&raw);
    }
    match keychain_entry_exists(CODEX_KEYCHAIN_SERVICE) {
        Some(true) => (
            CodingAgentLoginState::LoggedIn,
            Some("凭据保存在系统钥匙串".into()),
        ),
        Some(false) => (
            CodingAgentLoginState::NotLoggedIn,
            Some("未发现登录凭据，运行 codex login 完成登录".into()),
        ),
        None => (CodingAgentLoginState::Unknown, None),
    }
}

/// PATH 之外的常见安装点（find_on_path 对含分隔符的路径直接短路判存在）。
fn claude_binary_candidates(home: &Path) -> Vec<String> {
    vec![
        "claude".to_string(),
        home.join(".claude/local/claude")
            .to_string_lossy()
            .into_owned(),
        home.join(".local/bin/claude")
            .to_string_lossy()
            .into_owned(),
    ]
}

fn codex_binary_candidates(home: &Path) -> Vec<String> {
    vec![
        "codex".to_string(),
        home.join(".local/bin/codex").to_string_lossy().into_owned(),
    ]
}

pub fn collect_coding_agents_check() -> CodingAgentsCheckResult {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));

    let claude_dir = claude_config_dir(std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref(), &home);
    let codex_dir = codex_config_dir(std::env::var("CODEX_HOME").ok().as_deref(), &home);

    let claude_candidates = claude_binary_candidates(&home);
    let claude_refs: Vec<&str> = claude_candidates.iter().map(String::as_str).collect();
    let claude_probe = probe_commands(&claude_refs, &["--version"]);
    let (claude_login, claude_detail) = if claude_probe.found {
        detect_claude_login(&claude_dir)
    } else {
        (CodingAgentLoginState::Unknown, None)
    };

    let codex_candidates = codex_binary_candidates(&home);
    let codex_refs: Vec<&str> = codex_candidates.iter().map(String::as_str).collect();
    let codex_probe = probe_commands(&codex_refs, &["--version"]);
    let (codex_login, codex_detail) = if codex_probe.found {
        detect_codex_login(&codex_dir)
    } else {
        (CodingAgentLoginState::Unknown, None)
    };

    CodingAgentsCheckResult {
        generated_at_ms: now_ms(),
        platform: std::env::consts::OS.to_string(),
        agents: vec![
            CodingAgentStatus {
                id: "claude-code".into(),
                label: "Claude Code".into(),
                installed: claude_probe.found,
                version: claude_probe.version.or(claude_probe.error),
                path: claude_probe.path.map(|p| p.to_string_lossy().into_owned()),
                login_state: claude_login,
                login_detail: claude_detail,
                config_dir: claude_dir.to_string_lossy().into_owned(),
                skill_name: "claude-code".into(),
                install_hint: "npm install -g @anthropic-ai/claude-code".into(),
                login_hint: "运行 claude 按提示完成 OAuth 登录（或配置 ANTHROPIC_API_KEY）".into(),
            },
            CodingAgentStatus {
                id: "codex".into(),
                label: "Codex".into(),
                installed: codex_probe.found,
                version: codex_probe.version.or(codex_probe.error),
                path: codex_probe.path.map(|p| p.to_string_lossy().into_owned()),
                login_state: codex_login,
                login_detail: codex_detail,
                config_dir: codex_dir.to_string_lossy().into_owned(),
                skill_name: "codex".into(),
                install_hint: "npm install -g @openai/codex".into(),
                login_hint: "运行 codex login 完成登录（或在 ~/.codex/auth.json 配置 API Key）"
                    .into(),
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn claude_config_dir_prefers_env_override() {
        let home = Path::new("/home/u");
        assert_eq!(
            claude_config_dir(Some("/custom/claude"), home),
            PathBuf::from("/custom/claude")
        );
        assert_eq!(claude_config_dir(Some("  "), home), home.join(".claude"));
        assert_eq!(claude_config_dir(None, home), home.join(".claude"));
    }

    #[test]
    fn codex_config_dir_prefers_env_override() {
        let home = Path::new("/home/u");
        assert_eq!(
            codex_config_dir(Some("/custom/codex"), home),
            PathBuf::from("/custom/codex")
        );
        assert_eq!(codex_config_dir(None, home), home.join(".codex"));
    }

    #[test]
    fn claude_credentials_valid_expired_and_unknown() {
        let now = 1_000_000_000_000u64;
        let valid = format!(r#"{{"claudeAiOauth":{{"expiresAt":{}}}}}"#, now + 7_200_000);
        let (state, detail) = parse_claude_credentials(&valid, now);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);
        assert!(detail.unwrap().contains("小时"));

        let expired = format!(r#"{{"claudeAiOauth":{{"expiresAt":{}}}}}"#, now - 1_000);
        let (state, _) = parse_claude_credentials(&expired, now);
        assert_eq!(state, CodingAgentLoginState::Expired);

        let no_expiry = r#"{"claudeAiOauth":{"scopes":["user:inference"]}}"#;
        let (state, _) = parse_claude_credentials(no_expiry, now);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);

        let (state, _) = parse_claude_credentials("not json", now);
        assert_eq!(state, CodingAgentLoginState::Unknown);

        let (state, _) = parse_claude_credentials(r#"{"other":{}}"#, now);
        assert_eq!(state, CodingAgentLoginState::Unknown);
    }

    #[test]
    fn codex_auth_states() {
        let (state, detail) = parse_codex_auth(r#"{"OPENAI_API_KEY":"sk-xxx"}"#);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);
        assert!(detail.unwrap().contains("API Key"));

        let (state, detail) = parse_codex_auth(r#"{"tokens":{"id_token":"…"}}"#);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);
        assert!(detail.unwrap().contains("ChatGPT"));

        let (state, _) = parse_codex_auth(r#"{"OPENAI_API_KEY":"", "tokens": null}"#);
        assert_eq!(state, CodingAgentLoginState::NotLoggedIn);

        let (state, _) = parse_codex_auth("{broken");
        assert_eq!(state, CodingAgentLoginState::Unknown);
    }

    #[test]
    fn detect_login_reads_files_from_config_dirs() {
        let dir = tempfile::TempDir::new().unwrap();
        let claude_dir = dir.path().join("claude-cfg");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(
            claude_dir.join(".credentials.json"),
            format!(
                r#"{{"claudeAiOauth":{{"expiresAt":{}}}}}"#,
                now_ms() + 3_600_000
            ),
        )
        .unwrap();
        let (state, _) = detect_claude_login(&claude_dir);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);

        let codex_dir = dir.path().join("codex-cfg");
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(
            codex_dir.join("auth.json"),
            r#"{"tokens":{"access_token":"x"}}"#,
        )
        .unwrap();
        let (state, _) = detect_codex_login(&codex_dir);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);
    }

    #[test]
    fn binary_candidates_include_known_install_points() {
        let home = Path::new("/home/u");
        let claude = claude_binary_candidates(home);
        assert!(claude.iter().any(|c| c.ends_with(".claude/local/claude")));
        let codex = codex_binary_candidates(home);
        assert_eq!(codex[0], "codex");
    }
}
