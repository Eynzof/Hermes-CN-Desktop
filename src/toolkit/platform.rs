//! Platform toolset policy — Rust mirror of `platform-config.ts` `getPlatformTools`.
//!
//! Pure configuration policy operated on a `ToolConfigLike` value. The YAML
//! authority lives in Rust; the command layer reads config state and passes the
//! JSON to this pure function. No mutable state.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::schema::tool::{PlatformToolsResult, ToolConfigLike};

/// Platforms supported by the gateway.
pub const PLATFORMS: [&str; 7] = [
    "cli",
    "cron",
    "api-server",
    "telegram",
    "discord",
    "desktop",
    "webhook",
];

/// Composite toolsets that expand into configurable keys.
const COMPOSITE_TO_LEAVES: [(&str, &[&str]); 4] = [
    (
        "hermes_cli",
        &["core", "file", "terminal", "web", "memory", "skills"],
    ),
    ("hermes_discord", &["core", "memory", "skills"]),
    ("hermes_telegram", &["core", "memory", "skills"]),
    (
        "coding",
        &["core", "file", "terminal", "code_execution", "skills"],
    ),
];

/// Toolsets disabled by default (user must opt-in).
const DEFAULT_OFF_TOOLSETS: [&str; 8] = [
    "browser",
    "computer_use",
    "homeassistant",
    "x_search",
    "spotify",
    "video",
    "image_gen",
    "kanban",
];

/// Platform restrictions: these toolsets are ignored on the listed platforms.
const TOOLSET_PLATFORM_RESTRICTIONS: [(&str, &[&str]); 4] = [
    (
        "cron",
        &["browser", "computer_use", "terminal", "code_execution"],
    ),
    ("api-server", &["desktop_ui", "project"]),
    ("telegram", &["desktop_ui", "project"]),
    ("discord", &["desktop_ui", "project"]),
];

/// Options for `get_platform_tools`.
///
/// `env` is a tolerant map (values may be `null`/missing in IPC); only string
/// values with non-empty length count toward credential auto-enable detection.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformOpts {
    #[serde(default)]
    pub auto_enable_credentials: bool,
    #[serde(default)]
    pub env: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(default)]
    pub is_gui_session: bool,
}

/// Resolve the effective enabled toolset keys for a platform.
pub fn get_platform_tools(
    cfg: &ToolConfigLike,
    platform: &str,
    opts: &PlatformOpts,
) -> PlatformToolsResult {
    let env = normalize_env(&opts.env);

    // Start from raw list; recover non-configurable ones.
    let raw: Vec<String> = cfg
        .platform_toolsets
        .as_ref()
        .and_then(|m| m.get(platform).cloned())
        .unwrap_or_default();
    let mut enabled: BTreeSet<String> = raw.iter().cloned().collect();

    // Expand composites and add leaf toolsets so the UI can toggle them.
    let snapshot: Vec<String> = enabled.iter().cloned().collect();
    for key in &snapshot {
        if let Some(leaves) = composite_leaves(key) {
            for leaf in leaves {
                enabled.insert(leaf.to_string());
            }
        }
    }

    // Apply default-off removals.
    // Keep if user explicitly listed it, or a composite that includes it was listed.
    for off in DEFAULT_OFF_TOOLSETS {
        let explicit = raw.iter().any(|k| {
            let k = k.as_str();
            k == off
                || composite_leaves(k)
                    .map(|l| l.contains(&off))
                    .unwrap_or(false)
        });
        if !explicit {
            enabled.remove(off);
        }
    }

    // Platform restrictions.
    if let Some(restricted) = platform_restrictions(platform) {
        for r in restricted {
            enabled.remove(*r);
        }
    }

    // Credential auto-enable (best-effort, without running async probes).
    if opts.auto_enable_credentials {
        if has_env(&env, &["XAI_API_KEY", "X_API_BEARER_TOKEN"]) {
            enabled.insert("x_search".to_string());
        }
        if has_env(&env, &["HOME_ASSISTANT_TOKEN", "HASS_TOKEN"]) {
            enabled.insert("homeassistant".to_string());
        }
        if has_env(&env, &["SPOTIFY_CLIENT_ID"]) {
            enabled.insert("spotify".to_string());
        }
    }

    // GUI session surfaces desktop_ui + project.
    if opts.is_gui_session && platform == "cli" {
        enabled.insert("desktop_ui".to_string());
        enabled.insert("project".to_string());
    }

    // Global override applied last.
    let disabled: BTreeSet<String> = cfg
        .agent
        .as_ref()
        .and_then(|a| a.disabled_toolsets.clone())
        .unwrap_or_default()
        .into_iter()
        .collect();
    for d in &disabled {
        enabled.remove(d);
    }

    PlatformToolsResult {
        platform: platform.to_string(),
        enabled: enabled.into_iter().collect(),
        disabled: disabled.into_iter().collect(),
        known_plugin_toolsets: cfg.known_plugin_toolsets.clone().unwrap_or_default(),
        known_builtin_toolsets: cfg.known_builtin_toolsets.clone().unwrap_or_default(),
    }
}

fn normalize_env(env: &Option<BTreeMap<String, serde_json::Value>>) -> BTreeMap<String, String> {
    env.as_ref()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn composite_leaves(key: &str) -> Option<&'static [&'static str]> {
    for (k, leaves) in COMPOSITE_TO_LEAVES {
        if k == key {
            return Some(leaves);
        }
    }
    None
}

fn platform_restrictions(platform: &str) -> Option<&'static [&'static str]> {
    for (p, restricted) in TOOLSET_PLATFORM_RESTRICTIONS {
        if p == platform {
            return Some(restricted);
        }
    }
    None
}

fn has_env(env: &BTreeMap<String, String>, keys: &[&str]) -> bool {
    keys.iter()
        .any(|k| env.get(*k).map(|v| !v.is_empty()).unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn base_config() -> ToolConfigLike {
        ToolConfigLike {
            platform_toolsets: Some(BTreeMap::from([(
                "cli".to_string(),
                vec!["hermes_cli".to_string()],
            )])),
            ..Default::default()
        }
    }

    fn is_enabled(res: &PlatformToolsResult, name: &str) -> bool {
        res.enabled.iter().any(|e| e == name)
    }

    #[test]
    fn default_cli_bundle() {
        let res = get_platform_tools(&base_config(), "cli", &PlatformOpts::default());
        assert!(is_enabled(&res, "hermes_cli"));
        assert!(is_enabled(&res, "core"));
        assert!(is_enabled(&res, "file"));
    }

    #[test]
    fn default_off_toolsets_stay_disabled() {
        let res = get_platform_tools(&base_config(), "cli", &PlatformOpts::default());
        assert!(!is_enabled(&res, "browser"));
        assert!(!is_enabled(&res, "kanban"));
    }

    #[test]
    fn auto_enables_credential_toolsets_when_env_present() {
        let env = Some(BTreeMap::from([(
            "XAI_API_KEY".to_string(),
            serde_json::Value::String("x".to_string()),
        )]));
        let opts = PlatformOpts {
            auto_enable_credentials: true,
            env,
            ..Default::default()
        };
        let res = get_platform_tools(&base_config(), "cli", &opts);
        assert!(is_enabled(&res, "x_search"));
    }

    #[test]
    fn applies_agent_disabled_toolsets_last() {
        let mut cfg = base_config();
        cfg.agent = Some(crate::schema::tool::AgentConfig {
            disabled_toolsets: Some(vec!["web".to_string()]),
        });
        let res = get_platform_tools(&cfg, "cli", &PlatformOpts::default());
        assert!(!is_enabled(&res, "web"));
    }

    #[test]
    fn surfaces_desktop_ui_project_on_gui_sessions() {
        let opts = PlatformOpts {
            is_gui_session: true,
            ..Default::default()
        };
        let res = get_platform_tools(&base_config(), "cli", &opts);
        assert!(is_enabled(&res, "desktop_ui"));
        assert!(is_enabled(&res, "project"));
    }

    #[test]
    fn cron_platform_restrictions_apply() {
        let mut cfg = base_config();
        cfg.platform_toolsets.as_mut().unwrap().insert(
            "cron".to_string(),
            vec![
                "hermes_cli".to_string(),
                "browser".to_string(),
                "terminal".to_string(),
            ],
        );
        let res = get_platform_tools(&cfg, "cron", &PlatformOpts::default());
        assert!(!is_enabled(&res, "browser"));
        assert!(!is_enabled(&res, "terminal"));
        assert!(is_enabled(&res, "core"));
        assert!(is_enabled(&res, "file"));
    }

    #[test]
    fn returns_sorted_enabled_and_disabled() {
        let mut cfg = base_config();
        cfg.platform_toolsets.as_mut().unwrap().insert(
            "cli".to_string(),
            vec![
                "file".to_string(),
                "core".to_string(),
                "hermes_cli".to_string(),
            ],
        );
        let res = get_platform_tools(&cfg, "cli", &PlatformOpts::default());
        // BTreeSet iteration produces sorted output.
        assert!(res.enabled.windows(2).all(|w| w[0] < w[1]));
        assert!(res.disabled.is_empty());
    }

    #[test]
    fn known_maps_copied_through() {
        let mut cfg = base_config();
        cfg.known_plugin_toolsets =
            Some(BTreeMap::from([("p".to_string(), vec!["x".to_string()])]));
        cfg.known_builtin_toolsets =
            Some(BTreeMap::from([("b".to_string(), vec!["y".to_string()])]));
        let res = get_platform_tools(&cfg, "cli", &PlatformOpts::default());
        assert_eq!(
            res.known_plugin_toolsets.get("p").unwrap(),
            &vec!["x".to_string()]
        );
        assert_eq!(
            res.known_builtin_toolsets.get("b").unwrap(),
            &vec!["y".to_string()]
        );
    }

    #[test]
    fn platforms_listed_in_order() {
        assert_eq!(
            PLATFORMS,
            [
                "cli",
                "cron",
                "api-server",
                "telegram",
                "discord",
                "desktop",
                "webhook"
            ]
        );
    }
}
