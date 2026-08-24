//! Toolset catalog and resolver — Rust mirror of `packages/agent-tools/src/toolsets.ts`.
//!
//! Recursive `includes`, cycle-safe resolution, `all`/`*` wildcard handling,
//! custom toolsets overlay, and the `kanban` workflow gate (deliberately opt-in:
//! wildcard expansion skips `workflowGate` toolsets; explicit references include
//! them). Pure functions, no mutable state except a lazily-initialized static
//! catalog table.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use crate::schema::tool::{CustomToolset, ToolsetDef};

/// Options for `resolve_toolset`.
///
/// `is_gui_session` / `kanban_worker` are carried for API parity with the TS
/// signature; the resolver itself does not alter its output based on them (the
/// TS implementation likewise only references them in a no-op branch).
#[derive(Debug, Default, Clone)]
pub struct ToolsetResolveOpts<'a> {
    pub custom_toolsets: Option<&'a BTreeMap<String, CustomToolset>>,
    /// If true, `all`/`*` unions every static toolset except workflow-gated ones.
    pub include_all: bool,
    /// GUI session hint (inert in this resolver).
    pub is_gui_session: bool,
    /// Kanban worker context (inert in this resolver).
    pub kanban_worker: bool,
    /// Registry view: dynamic toolsets can be resolved by name (resolved as empty leaves).
    pub registry_toolsets: Option<&'a BTreeSet<String>>,
}

fn static_toolsets() -> &'static BTreeMap<String, ToolsetDef> {
    static TOOLSETS: OnceLock<BTreeMap<String, ToolsetDef>> = OnceLock::new();
    TOOLSETS.get_or_init(build_static_toolsets)
}

fn build_static_toolsets() -> BTreeMap<String, ToolsetDef> {
    let mut m = BTreeMap::new();

    // Core toolsets
    m.insert(
        "core".into(),
        td(
            "Core reasoning & control tools",
            &["todo", "clarify", "complete", "think", "delegate_task"],
            &[],
            Some("orchestration"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "file".into(),
        td(
            "Filesystem read/write/search tools",
            &[
                "file_read",
                "file_write",
                "file_search",
                "file_grep",
                "file_list",
            ],
            &[],
            Some("terminal-files"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "terminal".into(),
        td(
            "Local terminal / process execution",
            &[
                "terminal_run",
                "terminal_status",
                "process_start",
                "process_stop",
            ],
            &[],
            Some("terminal-files"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "web".into(),
        td(
            "Web search and page extraction",
            &["web_search", "web_extract", "web_fetch"],
            &[],
            Some("web"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "memory".into(),
        td(
            "Built-in memory read/write",
            &["memory_read", "memory_write", "memory_search"],
            &[],
            Some("memory-recall"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "session_search".into(),
        td(
            "Search and recall past sessions",
            &["session_search"],
            &[],
            Some("memory-recall"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "skills".into(),
        td(
            "Skill invocation",
            &["skill_invoke", "skill_search"],
            &[],
            Some("orchestration"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "code_execution".into(),
        td(
            "Sandboxed code execution",
            &["execute_code", "execute_code_status"],
            &["file"],
            Some("orchestration"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "cronjob".into(),
        td(
            "Scheduled task tools",
            &["cronjob_schedule", "cronjob_list", "cronjob_cancel"],
            &[],
            Some("automation"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "browser".into(),
        td(
            "Browser automation tools",
            &[
                "browser_navigate",
                "browser_snapshot",
                "browser_click",
                "browser_type",
                "browser_scroll",
                "browser_back",
                "browser_press",
                "browser_console",
                "browser_get_images",
                "browser_vision",
                "browser_cdp",
                "browser_dialog",
                "browser_exec",
            ],
            &[],
            Some("browser"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "computer_use".into(),
        td(
            "Computer-use / CUA tools",
            &["computer_click", "computer_type", "computer_screenshot"],
            &[],
            Some("media"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "homeassistant".into(),
        td(
            "Home Assistant controls",
            &[
                "ha_call_service",
                "ha_get_state",
                "ha_list_entities",
                "ha_list_services",
            ],
            &[],
            Some("integrations"),
            Some(&["ha"]),
            false,
            false,
        ),
    );
    m.insert(
        "x_search".into(),
        td(
            "X (Twitter) search",
            &["x_search"],
            &[],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "spotify".into(),
        td(
            "Spotify playback controls",
            &[
                "spotify_playback",
                "spotify_devices",
                "spotify_queue",
                "spotify_search",
                "spotify_playlists",
                "spotify_albums",
                "spotify_library",
            ],
            &[],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "google_meet".into(),
        td(
            "Google Meet headless bot",
            &[
                "meet_join",
                "meet_status",
                "meet_transcript",
                "meet_leave",
                "meet_say",
                "meet_setup",
            ],
            &[],
            Some("integrations"),
            Some(&["google_meet"]),
            false,
            false,
        ),
    );
    m.insert(
        "image_gen".into(),
        td(
            "Image generation",
            &["image_generate"],
            &[],
            Some("media"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "video".into(),
        td(
            "Video generation / editing",
            &["video_generate", "video_edit"],
            &[],
            Some("media"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "tts".into(),
        td(
            "Text-to-speech",
            &["tts_speak"],
            &[],
            Some("media"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "stt".into(),
        td(
            "Speech-to-text",
            &["stt_transcribe"],
            &[],
            Some("media"),
            None,
            false,
            false,
        ),
    );

    // Workflow-gated
    m.insert(
        "kanban".into(),
        td(
            "Kanban multi-agent board tools",
            &[
                "kanban_create_board",
                "kanban_create_task",
                "kanban_move_task",
                "kanban_assign_worker",
                "kanban_board_status",
            ],
            &[],
            Some("orchestration"),
            None,
            false,
            true,
        ),
    );
    m.insert(
        "batch".into(),
        td(
            "Batch processing tools",
            &["batch_run", "batch_status"],
            &[],
            Some("automation"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "event_hooks".into(),
        td(
            "Event hook registration and triggers",
            &[
                "event_hook_register",
                "event_hook_trigger",
                "event_hook_list",
            ],
            &[],
            Some("automation"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "deliverable".into(),
        td(
            "Deliverable packaging and artifact assembly",
            &["deliverable_create", "deliverable_add_file"],
            &[],
            Some("orchestration"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "subagent".into(),
        td(
            "Subagent swarm and delegation tools",
            &["agent_swarm", "subagent_list"],
            &[],
            Some("orchestration"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "automation_helpers".into(),
        td(
            "Automation blueprint and suggestion helpers",
            &["suggestions_get", "blueprint_match", "blueprint_list"],
            &[],
            Some("automation"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "mcp".into(),
        td(
            "MCP server management tools",
            &[
                "mcp_server_add",
                "mcp_server_remove",
                "mcp_server_list",
                "mcp_server_test",
            ],
            &[],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "acp_ide".into(),
        td(
            "ACP IDE integration tools",
            &["acp_ide_start", "acp_ide_status", "acp_ide_list_sessions"],
            &[],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "document_extract".into(),
        td(
            "Document text extraction",
            &["document_extract"],
            &[],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "subscription_proxy".into(),
        td(
            "Subscription proxy controls",
            &["subscription_proxy_status", "subscription_proxy_start"],
            &[],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "tool_gateway".into(),
        td(
            "Nous Tool Gateway routing",
            &["tool_gateway_status", "tool_gateway_call"],
            &[],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "codex_runtime".into(),
        td(
            "Codex app-server runtime controls",
            &["codex_runtime_toggle", "codex_runtime_status"],
            &[],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "egress_proxy".into(),
        td(
            "Egress proxy and secrets import",
            &[
                "egress_proxy_start",
                "egress_proxy_import_secrets",
                "egress_proxy_status",
            ],
            &[],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "observability".into(),
        td(
            "OpenTelemetry observability",
            &["observability_get_config", "observability_set_config"],
            &[],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "messaging".into(),
        td(
            "Messaging gateway platform controls",
            &[
                "messaging_configure",
                "messaging_status",
                "messaging_start",
                "messaging_stop",
                "messaging_send",
            ],
            &[],
            Some("integrations"),
            Some(&["messaging"]),
            false,
            false,
        ),
    );

    // GUI / desktop toolsets
    m.insert(
        "desktop_ui".into(),
        td(
            "Desktop UI session tools",
            &["desktop_notify", "desktop_pick_file", "desktop_preview"],
            &[],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );
    m.insert(
        "project".into(),
        td(
            "Project/workspace scoped tools",
            &["project_list", "project_switch", "project_index"],
            &["file"],
            Some("integrations"),
            None,
            false,
            false,
        ),
    );

    // Composite toolsets
    m.insert(
        "coding".into(),
        td(
            "Coding posture bundle",
            &[],
            &["core", "file", "terminal", "code_execution", "skills"],
            None,
            None,
            true,
            false,
        ),
    );
    m.insert(
        "hermes_cli".into(),
        td(
            "CLI default bundle",
            &[],
            &["core", "file", "terminal", "web", "memory", "skills"],
            None,
            None,
            false,
            false,
        ),
    );
    m.insert(
        "hermes_discord".into(),
        td(
            "Discord platform bundle",
            &[],
            &["core", "memory", "skills"],
            None,
            None,
            false,
            false,
        ),
    );
    m.insert(
        "hermes_telegram".into(),
        td(
            "Telegram platform bundle",
            &[],
            &["core", "memory", "skills"],
            None,
            None,
            false,
            false,
        ),
    );

    // Convenience aliases
    m.insert(
        "all_core".into(),
        td("Alias for core", &[], &["core"], None, None, false, false),
    );

    m
}

/// Build a `ToolsetDef` from a compact static-catalog row.
#[allow(clippy::too_many_arguments)]
fn td(
    description: &str,
    tools: &[&str],
    includes: &[&str],
    category: Option<&str>,
    tags: Option<&[&str]>,
    posture: bool,
    workflow_gate: bool,
) -> ToolsetDef {
    ToolsetDef {
        description: description.to_string(),
        tools: tools.iter().map(|s| s.to_string()).collect(),
        includes: includes.iter().map(|s| s.to_string()).collect(),
        category: category.map(|s| s.to_string()),
        tags: tags.map(|v| v.iter().map(|s| s.to_string()).collect()),
        posture: if posture { Some(true) } else { None },
        module: None,
        workflow_gate: if workflow_gate { Some(true) } else { None },
    }
}

/// Special wildcard keys.
fn is_wildcard(name: &str) -> bool {
    name == "all" || name == "*"
}

/// Resolve a single toolset key into a set of tool names.
pub fn resolve_toolset(name: &str, opts: &ToolsetResolveOpts) -> BTreeSet<String> {
    let mut result = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let custom: &BTreeMap<String, CustomToolset> = match opts.custom_toolsets {
        Some(m) => m,
        None => empty_custom(),
    };
    let registry: &BTreeSet<String> = match opts.registry_toolsets {
        Some(s) => s,
        None => empty_registry(),
    };

    if is_wildcard(name) {
        if !opts.include_all {
            return result;
        }
        for key in static_toolsets().keys() {
            let def = &static_toolsets()[key];
            if def.workflow_gate == Some(true) {
                continue;
            }
            visit(key, custom, &mut seen, &mut result);
        }
        for ct in custom.values() {
            for t in &ct.tools {
                result.insert(t.clone());
            }
            for inc in &ct.includes {
                visit(inc, custom, &mut seen, &mut result);
            }
        }
        return result;
    }

    // Dynamic registry-based toolset (plugins / MCP): resolves as an empty leaf.
    if registry.contains(name) {
        return result;
    }

    visit(name, custom, &mut seen, &mut result);
    result
}

fn visit(
    key: &str,
    custom: &BTreeMap<String, CustomToolset>,
    seen: &mut BTreeSet<String>,
    result: &mut BTreeSet<String>,
) {
    if seen.contains(key) {
        return;
    }
    seen.insert(key.to_string());

    if let Some(def) = static_toolsets().get(key) {
        for t in &def.tools {
            result.insert(t.clone());
        }
        for inc in &def.includes {
            visit(inc, custom, seen, result);
        }
        return;
    }

    if let Some(ct) = custom.get(key) {
        for t in &ct.tools {
            result.insert(t.clone());
        }
        for inc in &ct.includes {
            visit(inc, custom, seen, result);
        }
    }
    // Unknown keys (including dynamic registry names referenced from includes)
    // resolve to nothing, matching the TS resolver.
}

/// Resolve multiple toolset keys and merge their tool names.
pub fn resolve_multiple_toolsets(
    names: &[String],
    custom: &BTreeMap<String, CustomToolset>,
    disabled: &[String],
    registry_toolsets: &BTreeSet<String>,
    is_gui_session: bool,
    kanban_worker: bool,
) -> BTreeSet<String> {
    let mut resolved = BTreeSet::new();
    let has_all = names.iter().any(|n| is_wildcard(n));

    for name in names {
        if is_wildcard(name) {
            continue;
        }
        let opts = ToolsetResolveOpts {
            custom_toolsets: Some(custom),
            include_all: false,
            is_gui_session,
            kanban_worker,
            registry_toolsets: Some(registry_toolsets),
        };
        resolved.extend(resolve_toolset(name, &opts));
    }

    if has_all {
        let opts = ToolsetResolveOpts {
            custom_toolsets: Some(custom),
            include_all: true,
            is_gui_session,
            kanban_worker,
            registry_toolsets: Some(registry_toolsets),
        };
        resolved.extend(resolve_toolset("all", &opts));
    }

    // Subtract disabled toolsets.
    for d in disabled {
        let opts = ToolsetResolveOpts {
            custom_toolsets: Some(custom),
            include_all: true,
            is_gui_session,
            kanban_worker,
            registry_toolsets: Some(registry_toolsets),
        };
        for t in resolve_toolset(d, &opts) {
            resolved.remove(&t);
        }
    }

    resolved
}

/// True when the key names a known static, custom, or wildcard toolset.
pub fn validate_toolset(
    name: &str,
    custom_toolsets: &BTreeMap<String, CustomToolset>,
    registry_toolsets: &BTreeSet<String>,
) -> bool {
    if is_wildcard(name) {
        return true;
    }
    if static_toolsets().contains_key(name) {
        return true;
    }
    if custom_toolsets.contains_key(name) {
        return true;
    }
    if registry_toolsets.contains(name) {
        return true;
    }
    false
}

/// List all known toolset keys (static + custom + registry), sorted.
pub fn get_all_toolset_keys(
    custom_toolsets: &BTreeMap<String, CustomToolset>,
    registry_toolsets: &BTreeSet<String>,
) -> Vec<String> {
    let mut keys = BTreeSet::new();
    for k in static_toolsets().keys() {
        keys.insert(k.clone());
    }
    for k in custom_toolsets.keys() {
        keys.insert(k.clone());
    }
    for k in registry_toolsets {
        keys.insert(k.clone());
    }
    keys.into_iter().collect()
}

/// Return the category id for a static toolset, if assigned.
pub fn get_category_for_toolset(name: &str) -> Option<String> {
    static_toolsets()
        .get(name)
        .and_then(|def| def.category.clone())
}

/// Return all static toolset keys belonging to a category.
pub fn get_toolsets_by_category(category_id: &str) -> Vec<String> {
    static_toolsets()
        .iter()
        .filter(|(_, def)| def.category.as_deref() == Some(category_id))
        .map(|(key, _)| key.clone())
        .collect()
}

/// Bundle non-core tools into posture/platform toolsets (parity with Python
/// `bundle_non_core_tools`).
pub fn bundle_non_core_tools(
    tool_names: &[String],
    tool_to_toolset: &BTreeMap<String, String>,
) -> BTreeMap<String, Vec<String>> {
    let core = resolve_multiple_toolsets(
        &["core".to_string()],
        &BTreeMap::new(),
        &[],
        &BTreeSet::new(),
        false,
        false,
    );

    let mut bundles: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for name in tool_names {
        let toolset = tool_to_toolset
            .get(name)
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        if core.contains(name) {
            continue;
        }
        bundles.entry(toolset).or_default().push(name.clone());
    }
    bundles
}

fn empty_custom() -> &'static BTreeMap<String, CustomToolset> {
    static EMPTY: OnceLock<BTreeMap<String, CustomToolset>> = OnceLock::new();
    EMPTY.get_or_init(BTreeMap::new)
}

fn empty_registry() -> &'static BTreeSet<String> {
    static EMPTY: OnceLock<BTreeSet<String>> = OnceLock::new();
    EMPTY.get_or_init(BTreeSet::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn opts_empty() -> ToolsetResolveOpts<'static> {
        ToolsetResolveOpts::default()
    }

    fn set(vals: &[&str]) -> BTreeSet<String> {
        vals.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn static_toolsets_has_all_expected_keys() {
        let keys = static_toolsets().keys().cloned().collect::<BTreeSet<_>>();
        for expected in [
            "core",
            "file",
            "terminal",
            "web",
            "memory",
            "session_search",
            "skills",
            "code_execution",
            "cronjob",
            "browser",
            "computer_use",
            "homeassistant",
            "x_search",
            "spotify",
            "google_meet",
            "image_gen",
            "video",
            "tts",
            "stt",
            "kanban",
            "batch",
            "event_hooks",
            "deliverable",
            "subagent",
            "automation_helpers",
            "mcp",
            "acp_ide",
            "document_extract",
            "subscription_proxy",
            "tool_gateway",
            "codex_runtime",
            "egress_proxy",
            "observability",
            "messaging",
            "desktop_ui",
            "project",
            "coding",
            "hermes_cli",
            "hermes_discord",
            "hermes_telegram",
            "all_core",
        ] {
            assert!(keys.contains(expected), "missing toolset {expected}");
        }
    }

    #[test]
    fn resolve_core_returns_core_tools() {
        let out = resolve_toolset("core", &opts_empty());
        assert_eq!(
            out,
            set(&["todo", "clarify", "complete", "think", "delegate_task"])
        );
    }

    #[test]
    fn resolve_code_execution_includes_file() {
        let out = resolve_toolset("code_execution", &opts_empty());
        assert!(out.contains("execute_code"));
        assert!(out.contains("file_read"));
    }

    #[test]
    fn resolve_coding_expands_composite() {
        let out = resolve_toolset("coding", &opts_empty());
        for want in [
            "todo",
            "file_read",
            "terminal_run",
            "execute_code",
            "skill_invoke",
        ] {
            assert!(out.contains(want), "missing {want}");
        }
    }

    #[test]
    fn resolve_wildcard_excludes_workflow_gate() {
        let opts = ToolsetResolveOpts {
            include_all: true,
            ..Default::default()
        };
        let out = resolve_toolset("all", &opts);
        assert!(out.contains("todo"));
        assert!(out.contains("file_read"));
        assert!(
            !out.contains("kanban_create_board"),
            "kanban should be gated out of wildcard"
        );
    }

    #[test]
    fn resolve_wildcard_without_include_all_is_empty() {
        let out = resolve_toolset("all", &opts_empty());
        assert!(out.is_empty());
    }

    #[test]
    fn resolve_multiple_merges_and_subtracts_disabled() {
        let names = vec!["core".to_string(), "file".to_string()];
        let disabled = vec!["file".to_string()];
        let out = resolve_multiple_toolsets(
            &names,
            &BTreeMap::new(),
            &disabled,
            &BTreeSet::new(),
            false,
            false,
        );
        assert!(out.contains("todo"));
        assert!(!out.contains("file_read"), "file should be subtracted");
    }

    #[test]
    fn resolve_multiple_wildcard_plus_disabled() {
        let names = vec!["all".to_string()];
        let disabled = vec!["web".to_string()];
        let out = resolve_multiple_toolsets(
            &names,
            &BTreeMap::new(),
            &disabled,
            &BTreeSet::new(),
            false,
            false,
        );
        assert!(out.contains("todo"));
        assert!(!out.contains("web_search"), "web should be subtracted");
    }

    #[test]
    fn custom_toolset_overlay_resolves() {
        let mut custom = BTreeMap::new();
        custom.insert(
            "ops".to_string(),
            CustomToolset {
                name: "ops".to_string(),
                tools: vec!["terminal_run".to_string()],
                includes: vec!["core".to_string()],
                description: "ops bundle".to_string(),
            },
        );
        let opts = ToolsetResolveOpts {
            custom_toolsets: Some(&custom),
            ..Default::default()
        };
        let out = resolve_toolset("ops", &opts);
        assert!(out.contains("terminal_run"));
        assert!(out.contains("todo"));
    }

    #[test]
    fn custom_toolset_cycle_is_safe() {
        let mut custom = BTreeMap::new();
        custom.insert(
            "a".to_string(),
            CustomToolset {
                name: "a".to_string(),
                tools: vec!["tool_a".to_string()],
                includes: vec!["b".to_string()],
                description: "".to_string(),
            },
        );
        custom.insert(
            "b".to_string(),
            CustomToolset {
                name: "b".to_string(),
                tools: vec!["tool_b".to_string()],
                includes: vec!["a".to_string()],
                description: "".to_string(),
            },
        );
        let opts = ToolsetResolveOpts {
            custom_toolsets: Some(&custom),
            ..Default::default()
        };
        let out = resolve_toolset("a", &opts);
        assert!(out.contains("tool_a"));
        assert!(out.contains("tool_b"));
    }

    #[test]
    fn registry_toolset_resolves_as_empty_leaf() {
        let mut registry = BTreeSet::new();
        registry.insert("mcp_plugin".to_string());
        let opts = ToolsetResolveOpts {
            registry_toolsets: Some(&registry),
            ..Default::default()
        };
        let out = resolve_toolset("mcp_plugin", &opts);
        assert!(out.is_empty());
    }

    #[test]
    fn validate_toolset_covers_static_custom_wildcard() {
        let custom = BTreeMap::from([(
            "ops".to_string(),
            CustomToolset {
                name: "ops".to_string(),
                tools: vec![],
                includes: vec![],
                description: "".to_string(),
            },
        )]);
        let registry = BTreeSet::from(["mcp_plugin".to_string()]);
        assert!(validate_toolset("core", &BTreeMap::new(), &BTreeSet::new()));
        assert!(validate_toolset("all", &BTreeMap::new(), &BTreeSet::new()));
        assert!(validate_toolset("*", &BTreeMap::new(), &BTreeSet::new()));
        assert!(validate_toolset("ops", &custom, &BTreeSet::new()));
        assert!(validate_toolset("mcp_plugin", &BTreeMap::new(), &registry));
        assert!(!validate_toolset(
            "nope",
            &BTreeMap::new(),
            &BTreeSet::new()
        ));
    }

    #[test]
    fn get_all_toolset_keys_sorts_and_merges() {
        let custom = BTreeMap::from([(
            "zzz".to_string(),
            CustomToolset {
                name: "zzz".to_string(),
                tools: vec![],
                includes: vec![],
                description: "".to_string(),
            },
        )]);
        let registry = BTreeSet::from(["aaa".to_string()]);
        let keys = get_all_toolset_keys(&custom, &registry);
        assert!(keys.windows(2).all(|w| w[0] < w[1]), "keys must be sorted");
        assert!(keys.contains(&"aaa".to_string()));
        assert!(keys.contains(&"zzz".to_string()));
        assert!(keys.contains(&"core".to_string()));
    }

    #[test]
    fn get_category_for_toolset_returns_category() {
        assert_eq!(
            get_category_for_toolset("core").as_deref(),
            Some("orchestration")
        );
        assert_eq!(get_category_for_toolset("nope"), None);
    }

    #[test]
    fn get_toolsets_by_category_groups() {
        let orchestration = get_toolsets_by_category("orchestration");
        assert!(orchestration.contains(&"core".to_string()));
        assert!(orchestration.contains(&"skills".to_string()));
        assert!(!orchestration.contains(&"file".to_string()));
    }

    #[test]
    fn bundle_non_core_tools_excludes_core_members() {
        let names = vec![
            "todo".to_string(),
            "file_read".to_string(),
            "web_search".to_string(),
            "ha_call_service".to_string(),
        ];
        let tool_to_toolset = BTreeMap::from([
            ("todo".to_string(), "core".to_string()),
            ("file_read".to_string(), "file".to_string()),
            ("web_search".to_string(), "web".to_string()),
            ("ha_call_service".to_string(), "homeassistant".to_string()),
        ]);
        let bundles = bundle_non_core_tools(&names, &tool_to_toolset);
        assert!(!bundles.contains_key("core"));
        assert_eq!(bundles.get("file").unwrap().len(), 1);
        assert_eq!(bundles.get("web").unwrap().len(), 1);
        assert_eq!(bundles.get("homeassistant").unwrap().len(), 1);
    }

    // Exhaustive parity: every static key must pass validate_toolset and yield a
    // non-empty resolve set (all composite/bundle toolsets expand to named leaves).
    #[test]
    fn resolve_every_static_key_is_non_empty() {
        for key in static_toolsets().keys() {
            let opts = ToolsetResolveOpts::default();
            let out = resolve_toolset(key, &opts);
            assert!(!out.is_empty(), "expected non-empty resolution for {key}");
            assert!(validate_toolset(key, &BTreeMap::new(), &BTreeSet::new()));
        }
    }
}
