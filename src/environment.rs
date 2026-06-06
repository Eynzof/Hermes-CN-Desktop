//! Desktop environment diagnostics.
//!
//! The desktop uses an isolated managed runtime, so these checks are deliberately
//! read-only from the user's perspective: they report whether the runtime tree,
//! dashboard, and optional helper tools are available, but they do not install or
//! repair anything automatically.

use serde::Serialize;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::process::{dashboard, runtime};
use crate::state::AppStateInner;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EnvironmentCheckStatus {
    Ok,
    Warning,
    Error,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EnvironmentCheckCategory {
    Core,
    Runtime,
    Tools,
    Browser,
    Paths,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentCheckItem {
    pub id: String,
    pub category: EnvironmentCheckCategory,
    pub label: String,
    pub status: EnvironmentCheckStatus,
    pub required: bool,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommendation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentCheckResult {
    pub generated_at_ms: u64,
    pub platform: String,
    pub arch: String,
    pub runtime_root: String,
    pub hermes_home: String,
    pub current_profile: String,
    pub items: Vec<EnvironmentCheckItem>,
}

#[derive(Debug, Clone)]
struct CommandProbe {
    found: bool,
    path: Option<PathBuf>,
    version: Option<String>,
    error: Option<String>,
}

trait EnvironmentPathValue {
    fn to_environment_path_string(&self) -> String;
}

impl EnvironmentPathValue for &Path {
    fn to_environment_path_string(&self) -> String {
        self.to_string_lossy().to_string()
    }
}

impl EnvironmentPathValue for &PathBuf {
    fn to_environment_path_string(&self) -> String {
        self.to_string_lossy().to_string()
    }
}

impl EnvironmentPathValue for PathBuf {
    fn to_environment_path_string(&self) -> String {
        self.to_string_lossy().to_string()
    }
}

impl EnvironmentPathValue for String {
    fn to_environment_path_string(&self) -> String {
        self.clone()
    }
}

impl EnvironmentPathValue for &str {
    fn to_environment_path_string(&self) -> String {
        (*self).to_string()
    }
}

impl EnvironmentCheckItem {
    fn new(
        id: &str,
        category: EnvironmentCheckCategory,
        label: &str,
        status: EnvironmentCheckStatus,
        required: bool,
        summary: impl Into<String>,
    ) -> Self {
        Self {
            id: id.to_string(),
            category,
            label: label.to_string(),
            status,
            required,
            summary: summary.into(),
            version: None,
            path: None,
            details: None,
            recommendation: None,
        }
    }

    fn version(mut self, version: Option<String>) -> Self {
        self.version = version;
        self
    }

    fn path(mut self, path: Option<impl EnvironmentPathValue>) -> Self {
        self.path = path.map(|p| p.to_environment_path_string());
        self
    }

    fn details(mut self, details: Option<impl Into<String>>) -> Self {
        self.details = details.map(Into::into);
        self
    }

    fn recommendation(mut self, recommendation: Option<impl Into<String>>) -> Self {
        self.recommendation = recommendation.map(Into::into);
        self
    }
}

/// Fast startup preflight used by `main.rs` before downloading/spawning the
/// managed runtime. This checks only directories that the boot path must write
/// to and intentionally skips optional tools.
pub fn check_bootstrap_environment(hermes_home: &str) -> Result<(), String> {
    let runtime_root = runtime::runtime_root();
    check_writable_dir(&runtime_root).map_err(|e| {
        format!(
            "runtime 目录不可写: {}。请检查磁盘权限，或设置 HERMES_DESKTOP_RUNTIME_ROOT 指向可写目录。错误: {}",
            runtime_root.display(),
            e
        )
    })?;

    let hermes_home = PathBuf::from(hermes_home);
    check_writable_dir(&hermes_home).map_err(|e| {
        format!(
            "HERMES_HOME 不可写: {}。请检查磁盘权限后重试。错误: {}",
            hermes_home.display(),
            e
        )
    })?;

    let gateway_dir = runtime::gateway_runtime_dir();
    check_writable_dir(&gateway_dir).map_err(|e| {
        format!(
            "gateway runtime 目录不可写: {}。请检查磁盘权限后重试。错误: {}",
            gateway_dir.display(),
            e
        )
    })?;

    Ok(())
}

pub async fn collect_environment_check(inner: &AppStateInner) -> EnvironmentCheckResult {
    let runtime_root = runtime::runtime_root();
    let hermes_home = if inner.hermes_home.trim().is_empty() {
        runtime::hermes_home_dir().to_string_lossy().to_string()
    } else {
        inner.hermes_home.clone()
    };
    let current = runtime::read_current_record();
    let mut items = Vec::new();

    items.push(check_writable_item(
        "runtime-root",
        EnvironmentCheckCategory::Core,
        "Runtime 根目录",
        true,
        &runtime_root,
        "runtime 根目录可写",
        "runtime 根目录不可写，桌面端无法安装或更新 managed runtime",
        Some("检查目录权限，或设置 HERMES_DESKTOP_RUNTIME_ROOT 指向可写目录"),
    ));

    items.push(check_writable_item(
        "hermes-home",
        EnvironmentCheckCategory::Core,
        "HERMES_HOME",
        true,
        Path::new(&hermes_home),
        "HERMES_HOME 可写",
        "HERMES_HOME 不可写，配置、会话与日志无法保存",
        Some("检查目录权限，或重新安装桌面端"),
    ));

    items.push(check_writable_item(
        "gateway-runtime-dir",
        EnvironmentCheckCategory::Core,
        "Gateway runtime 目录",
        true,
        &runtime::gateway_runtime_dir(),
        "Gateway runtime 目录可写",
        "Gateway runtime 目录不可写，消息网关锁文件和运行态无法写入",
        Some("检查 runtime 目录权限后重启桌面端"),
    ));

    match &current {
        Some(record) => {
            items.push(
                EnvironmentCheckItem::new(
                    "current-runtime-record",
                    EnvironmentCheckCategory::Runtime,
                    "current.json",
                    EnvironmentCheckStatus::Ok,
                    true,
                    format!("已指向 runtime {}", record.runtime_version),
                )
                .path(Some(runtime::current_record_path_display())),
            );

            let executable = PathBuf::from(&record.executable_path);
            if executable.is_file() {
                items.push(
                    EnvironmentCheckItem::new(
                        "runtime-executable",
                        EnvironmentCheckCategory::Runtime,
                        "Runtime 可执行文件",
                        EnvironmentCheckStatus::Ok,
                        true,
                        "runtime 可执行文件存在；版本信息来自 current.json",
                    )
                    .path(Some(&executable))
                    .version(Some(format!(
                        "{} / {}.{}",
                        record.kernel_version, record.runtime_flavor, record.runtime_revision
                    )))
                    .recommendation(Some(
                        "如果 dashboard 启动异常，请在高级/内核页重装或回滚 runtime",
                    )),
                );
            } else {
                items.push(
                    EnvironmentCheckItem::new(
                        "runtime-executable",
                        EnvironmentCheckCategory::Runtime,
                        "Runtime 可执行文件",
                        EnvironmentCheckStatus::Error,
                        true,
                        "current.json 指向的 runtime 可执行文件不存在",
                    )
                    .path(Some(&executable))
                    .recommendation(Some("在高级/内核页安装 runtime 更新，或重新安装桌面端")),
                );
            }
        }
        None => {
            items.push(
                EnvironmentCheckItem::new(
                    "current-runtime-record",
                    EnvironmentCheckCategory::Runtime,
                    "current.json",
                    EnvironmentCheckStatus::Error,
                    true,
                    "未找到 managed runtime 记录",
                )
                .path(Some(runtime::current_record_path_display()))
                .recommendation(Some("重新启动桌面端，让内置 runtime 安装流程重新执行")),
            );
            items.push(
                EnvironmentCheckItem::new(
                    "runtime-executable",
                    EnvironmentCheckCategory::Runtime,
                    "Runtime 可执行文件",
                    EnvironmentCheckStatus::Unknown,
                    true,
                    "runtime 尚未安装，无法检查可执行文件",
                )
                .recommendation(Some("等待首次启动安装完成，或重新安装桌面端")),
            );
        }
    }

    if inner.api_base_url.trim().is_empty() {
        items.push(
            EnvironmentCheckItem::new(
                "dashboard-api",
                EnvironmentCheckCategory::Runtime,
                "Dashboard API",
                EnvironmentCheckStatus::Unknown,
                true,
                "Dashboard 尚未写入 API 地址",
            )
            .recommendation(Some(
                "等待启动完成；如长时间不变，请复制诊断信息排查 runtime 启动失败原因",
            )),
        );
        items.push(EnvironmentCheckItem::new(
            "dashboard-sse",
            EnvironmentCheckCategory::Runtime,
            "SSE 事件路由",
            EnvironmentCheckStatus::Unknown,
            true,
            "Dashboard 尚未启动，无法检查 /api/v2/events",
        ));
    } else {
        items.push(
            check_dashboard_status(&inner.api_base_url, inner.session_token.as_deref()).await,
        );
        let supports_sse = dashboard::dashboard_supports_sse(&inner.api_base_url).await;
        items.push(
            EnvironmentCheckItem::new(
                "dashboard-sse",
                EnvironmentCheckCategory::Runtime,
                "SSE 事件路由",
                if supports_sse {
                    EnvironmentCheckStatus::Ok
                } else {
                    EnvironmentCheckStatus::Error
                },
                true,
                if supports_sse {
                    "Dashboard 支持 /api/v2/events 与桌面端默认 SSE transport"
                } else {
                    "Dashboard 缺少 /api/v2/events，默认 SSE transport 会失败"
                },
            )
            .path(Some(format!(
                "{}/api/v2/events",
                inner.api_base_url.trim_end_matches('/')
            )))
            .recommendation(
                (!supports_sse)
                    .then_some("升级 hermes-agent-cn runtime，或临时切换到 WebSocket transport"),
            ),
        );
    }

    items.push(tool_item(
        "git",
        "Git",
        &["git"],
        &["--version"],
        false,
        "Git 可用，用于源码更新、部分技能和仓库操作",
        "Git 未找到；大多数基础功能可用，但源码/仓库相关能力会受限",
        Some("安装 Git：macOS 可运行 xcode-select --install，Windows 安装 Git for Windows"),
    ));
    items.push(tool_item(
        "bash",
        "Bash / Git Bash",
        bash_candidates().as_slice(),
        &["--version"],
        false,
        "Bash 可用，终端工具可执行 POSIX shell 命令",
        "Bash 未找到；Windows 上终端工具通常需要 Git Bash",
        Some("Windows 请安装 Git for Windows；macOS/Linux 通常系统自带 bash"),
    ));
    items.push(check_node_item());
    items.push(tool_item(
        "npm",
        "npm",
        npm_candidates().as_slice(),
        &["--version"],
        false,
        "npm 可用，可安装浏览器工具等 Node 依赖",
        "npm 未找到；浏览器工具或部分扩展能力可能无法安装",
        Some("安装 Node.js LTS，或确认 npm 所在目录已加入 PATH"),
    ));
    items.push(tool_item(
        "ripgrep",
        "ripgrep (rg)",
        &["rg"],
        &["--version"],
        false,
        "ripgrep 可用，文件搜索会更快",
        "ripgrep 未找到；文件搜索会退回较慢实现或部分能力不可用",
        Some("安装 ripgrep：brew install ripgrep / winget install BurntSushi.ripgrep.MSVC"),
    ));
    items.push(tool_item(
        "ffmpeg",
        "ffmpeg",
        &["ffmpeg"],
        &["-version"],
        false,
        "ffmpeg 可用，音视频处理能力可用",
        "ffmpeg 未找到；音视频转码、部分语音/媒体能力会受限",
        Some("安装 ffmpeg：brew install ffmpeg / winget install Gyan.FFmpeg"),
    ));
    let mut agent_browser = tool_item(
        "agent-browser",
        "agent-browser",
        agent_browser_candidates().as_slice(),
        &["--version"],
        false,
        "agent-browser CLI 可用，浏览器自动化能力更完整",
        "agent-browser 未找到；浏览器自动化工具可能不可用",
        Some("安装 Node.js 后运行 npm install -g agent-browser"),
    );
    agent_browser.category = EnvironmentCheckCategory::Browser;
    items.push(agent_browser);
    items.push(browser_executable_item(Path::new(&hermes_home)));

    EnvironmentCheckResult {
        generated_at_ms: now_ms(),
        platform: current_platform_label(),
        arch: std::env::consts::ARCH.to_string(),
        runtime_root: runtime_root.to_string_lossy().to_string(),
        hermes_home,
        current_profile: inner.current_profile.clone(),
        items,
    }
}

async fn check_dashboard_status(api_base_url: &str, token: Option<&str>) -> EnvironmentCheckItem {
    let url = format!("{}/api/status", api_base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let mut req = client.get(&url).timeout(std::time::Duration::from_secs(4));
    if let Some(token) = token {
        req = req.header("X-Hermes-Session-Token", token);
    }
    match req.send().await {
        Ok(res) if res.status().is_success() => EnvironmentCheckItem::new(
            "dashboard-api",
            EnvironmentCheckCategory::Runtime,
            "Dashboard API",
            EnvironmentCheckStatus::Ok,
            true,
            format!("Dashboard API 可访问 ({})", res.status()),
        )
        .path(Some(api_base_url.to_string())),
        Ok(res) => EnvironmentCheckItem::new(
            "dashboard-api",
            EnvironmentCheckCategory::Runtime,
            "Dashboard API",
            EnvironmentCheckStatus::Warning,
            true,
            format!("Dashboard API 返回 {}", res.status()),
        )
        .path(Some(api_base_url.to_string()))
        .recommendation(Some("检查 dashboard 日志或重启桌面端")),
        Err(err) => EnvironmentCheckItem::new(
            "dashboard-api",
            EnvironmentCheckCategory::Runtime,
            "Dashboard API",
            EnvironmentCheckStatus::Error,
            true,
            "Dashboard API 无法访问",
        )
        .path(Some(api_base_url.to_string()))
        .details(Some(err.to_string()))
        .recommendation(Some("检查 runtime 是否仍在运行，或重启桌面端")),
    }
}

fn check_writable_item(
    id: &str,
    category: EnvironmentCheckCategory,
    label: &str,
    required: bool,
    path: &Path,
    ok_summary: &str,
    fail_summary: &str,
    recommendation: Option<&str>,
) -> EnvironmentCheckItem {
    match check_writable_dir(path) {
        Ok(()) => EnvironmentCheckItem::new(
            id,
            category,
            label,
            EnvironmentCheckStatus::Ok,
            required,
            ok_summary,
        )
        .path(Some(path)),
        Err(err) => EnvironmentCheckItem::new(
            id,
            category,
            label,
            EnvironmentCheckStatus::Error,
            required,
            fail_summary,
        )
        .path(Some(path))
        .details(Some(err))
        .recommendation(recommendation),
    }
}

fn check_writable_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let probe = path.join(format!(".hermes-env-check-{}", std::process::id()));
    fs::write(&probe, b"ok").map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

fn tool_item(
    id: &str,
    label: &str,
    commands: &[&str],
    version_args: &[&str],
    required: bool,
    ok_summary: &str,
    missing_summary: &str,
    recommendation: Option<&str>,
) -> EnvironmentCheckItem {
    let probe = probe_commands(commands, version_args);
    if probe.found {
        let status = if probe.error.is_some() {
            EnvironmentCheckStatus::Warning
        } else {
            EnvironmentCheckStatus::Ok
        };
        EnvironmentCheckItem::new(
            id,
            EnvironmentCheckCategory::Tools,
            label,
            status,
            required,
            ok_summary,
        )
        .path(probe.path.as_ref())
        .version(probe.version)
        .details(probe.error)
        .recommendation(
            (status == EnvironmentCheckStatus::Warning)
                .then_some("命令存在但版本探测失败，请确认它可以在终端中正常运行"),
        )
    } else {
        EnvironmentCheckItem::new(
            id,
            EnvironmentCheckCategory::Tools,
            label,
            if required {
                EnvironmentCheckStatus::Error
            } else {
                EnvironmentCheckStatus::Warning
            },
            required,
            missing_summary,
        )
        .details(probe.error)
        .recommendation(recommendation)
    }
}

fn check_node_item() -> EnvironmentCheckItem {
    let probe = probe_commands(&["node"], &["--version"]);
    if !probe.found {
        return EnvironmentCheckItem::new(
            "node",
            EnvironmentCheckCategory::Tools,
            "Node.js",
            EnvironmentCheckStatus::Warning,
            false,
            "Node.js 未找到；浏览器工具和部分扩展能力可能不可用",
        )
        .details(probe.error)
        .recommendation(Some("安装 Node.js LTS 20.19+ 或 22.12+"));
    }

    let version_text = probe.version.clone().unwrap_or_default();
    let ok_version = node_satisfies_build(&version_text);
    EnvironmentCheckItem::new(
        "node",
        EnvironmentCheckCategory::Tools,
        "Node.js",
        if ok_version {
            EnvironmentCheckStatus::Ok
        } else {
            EnvironmentCheckStatus::Warning
        },
        false,
        if ok_version {
            "Node.js 版本满足桌面端与浏览器工具构建要求"
        } else {
            "Node.js 版本偏旧，浏览器工具或本地构建可能失败"
        },
    )
    .path(probe.path.as_ref())
    .version(probe.version)
    .details(probe.error)
    .recommendation((!ok_version).then_some("升级到 Node.js 20.19+ 或 22.12+"))
}

fn browser_executable_item(hermes_home: &Path) -> EnvironmentCheckItem {
    let env_path = find_env_value(&hermes_home.join(".env"), "AGENT_BROWSER_EXECUTABLE_PATH");
    match env_path {
        Some(path) if Path::new(&path).is_file() => EnvironmentCheckItem::new(
            "browser-executable",
            EnvironmentCheckCategory::Browser,
            "浏览器执行文件",
            EnvironmentCheckStatus::Ok,
            false,
            "AGENT_BROWSER_EXECUTABLE_PATH 指向的浏览器存在",
        )
        .path(Some(path)),
        Some(path) => EnvironmentCheckItem::new(
            "browser-executable",
            EnvironmentCheckCategory::Browser,
            "浏览器执行文件",
            EnvironmentCheckStatus::Warning,
            false,
            "AGENT_BROWSER_EXECUTABLE_PATH 已配置，但目标文件不存在",
        )
        .path(Some(path))
        .recommendation(Some(
            "更新 .env 中的 AGENT_BROWSER_EXECUTABLE_PATH，或重新安装浏览器工具",
        )),
        None => EnvironmentCheckItem::new(
            "browser-executable",
            EnvironmentCheckCategory::Browser,
            "浏览器执行文件",
            EnvironmentCheckStatus::Unknown,
            false,
            "未在 .env 中配置 AGENT_BROWSER_EXECUTABLE_PATH；浏览器工具会尝试使用自身默认策略",
        )
        .recommendation(Some(
            "如浏览器工具不可用，可安装 agent-browser 或配置 AGENT_BROWSER_EXECUTABLE_PATH",
        )),
    }
}

fn find_env_value(path: &Path, key: &str) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((left, right)) = trimmed.split_once('=') else {
            continue;
        };
        if left.trim() != key {
            continue;
        }
        let mut value = right.trim().to_string();
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value = value[1..value.len().saturating_sub(1)].to_string();
        }
        return Some(value).filter(|v| !v.trim().is_empty());
    }
    None
}

fn probe_commands(commands: &[&str], version_args: &[&str]) -> CommandProbe {
    let mut missing = Vec::new();
    for command in commands {
        match find_on_path(command) {
            Some(path) => {
                let version_probe = run_version_command(&path, version_args);
                return CommandProbe {
                    found: true,
                    path: Some(path),
                    version: version_probe.version,
                    error: version_probe.error,
                };
            }
            None => missing.push(*command),
        }
    }
    CommandProbe {
        found: false,
        path: None,
        version: None,
        error: Some(format!("未在 PATH 中找到 {}", missing.join(" / "))),
    }
}

fn run_version_command(command: &Path, args: &[&str]) -> CommandProbe {
    let output = Command::new(command)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let first = stdout
                .lines()
                .chain(stderr.lines())
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string());
            CommandProbe {
                found: true,
                path: Some(command.to_path_buf()),
                version: first,
                error: (!output.status.success()).then(|| {
                    format!(
                        "版本命令退出码 {}{}",
                        output.status,
                        if stderr.is_empty() {
                            String::new()
                        } else {
                            format!(": {}", stderr)
                        }
                    )
                }),
            }
        }
        Err(err) => CommandProbe {
            found: true,
            path: Some(command.to_path_buf()),
            version: None,
            error: Some(err.to_string()),
        },
    }
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let command_path = Path::new(command);
    if command_path.is_absolute() || command.contains(std::path::MAIN_SEPARATOR) {
        return command_path.is_file().then(|| command_path.to_path_buf());
    }

    let path = env::var_os("PATH")?;
    let candidates = executable_candidates(command);
    for dir in env::split_paths(&path) {
        for candidate in &candidates {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn executable_candidates(command: &str) -> Vec<OsString> {
    #[cfg(target_os = "windows")]
    {
        let mut out = Vec::new();
        let has_ext = Path::new(command).extension().is_some();
        if has_ext {
            out.push(OsString::from(command));
            return out;
        }
        let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        for ext in pathext.split(';').filter(|s| !s.is_empty()) {
            out.push(OsString::from(format!("{}{}", command, ext)));
            out.push(OsString::from(format!(
                "{}{}",
                command,
                ext.to_ascii_lowercase()
            )));
        }
        out.push(OsString::from(command));
        out
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![OsString::from(command)]
    }
}

fn bash_candidates() -> Vec<&'static str> {
    #[cfg(target_os = "windows")]
    {
        vec!["bash", "bash.exe"]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec!["bash"]
    }
}

fn npm_candidates() -> Vec<&'static str> {
    #[cfg(target_os = "windows")]
    {
        vec!["npm.cmd", "npm.exe", "npm"]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec!["npm"]
    }
}

fn agent_browser_candidates() -> Vec<&'static str> {
    #[cfg(target_os = "windows")]
    {
        vec!["agent-browser.cmd", "agent-browser.exe", "agent-browser"]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec!["agent-browser"]
    }
}

fn node_satisfies_build(version: &str) -> bool {
    let Some((major, minor, _patch)) = parse_semverish(version) else {
        return false;
    };
    major > 22 || (major == 22 && minor >= 12) || (major == 20 && minor >= 19)
}

fn parse_semverish(version: &str) -> Option<(u64, u64, u64)> {
    let trimmed = version.trim().trim_start_matches('v');
    let mut nums = trimmed
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty());
    let major = nums.next()?.parse().ok()?;
    let minor = nums.next().unwrap_or("0").parse().ok()?;
    let patch = nums.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn current_platform_label() -> String {
    if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else {
        std::env::consts::OS.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn node_version_policy_matches_vite_requirement() {
        assert!(!node_satisfies_build("v20.18.1"));
        assert!(node_satisfies_build("v20.19.0"));
        assert!(!node_satisfies_build("v22.11.0"));
        assert!(node_satisfies_build("v22.12.0"));
        assert!(node_satisfies_build("v23.0.0"));
    }

    #[test]
    fn semver_parser_accepts_common_version_lines() {
        assert_eq!(parse_semverish("v22.12.0"), Some((22, 12, 0)));
        assert_eq!(parse_semverish("node 20.19.1"), Some((20, 19, 1)));
        assert_eq!(parse_semverish("git version 2.54.0"), Some((2, 54, 0)));
        assert_eq!(parse_semverish("not a version"), None);
    }

    #[test]
    fn env_value_parser_handles_quotes_and_comments() {
        let dir = tempfile::tempdir().unwrap();
        let env_file = dir.path().join(".env");
        fs::write(
            &env_file,
            "# comment\nOPENAI_API_KEY=secret\nAGENT_BROWSER_EXECUTABLE_PATH=\"/Applications/Browser.app/bin\"\n",
        )
        .unwrap();
        assert_eq!(
            find_env_value(&env_file, "AGENT_BROWSER_EXECUTABLE_PATH"),
            Some("/Applications/Browser.app/bin".to_string())
        );
        assert_eq!(find_env_value(&env_file, "MISSING"), None);
    }

    #[test]
    fn writable_dir_probe_creates_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nested");
        check_writable_dir(&target).unwrap();
        assert!(target.is_dir());
    }
}
