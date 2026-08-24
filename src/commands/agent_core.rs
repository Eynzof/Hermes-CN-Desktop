//! Narrow `#[tauri::command]` wrappers for the migrated agent-core deterministic
//! subset. All functions are pure (no `AppState`, no I/O) and return
//! `serde_json::Value`; malformed args fail at the serde IPC boundary.

use crate::compaction::{build_cache_plan, plan_compaction};
use crate::cron::parse_cron_expression;
use crate::error::{AppError, AppResult};
use crate::graph::build_memory_graph;
use crate::schema::compaction::{CachePlanRequest, CompactionRequest};
use crate::schema::cron::{CronNextRequest, CronNextResponse};
use crate::schema::graph::MemoryGraphRequest;
use crate::schema::skills::{parse_frontmatter_result, FrontmatterRequest};
use crate::schema::tokenize::{TokenizeRequest, TokenizeResponse};
use crate::tokenize::{count_tokens_batch, fallback_count};

fn to_value<T: serde::Serialize>(value: T) -> AppResult<serde_json::Value> {
    serde_json::to_value(value).map_err(|e| AppError::Internal(format!("serialize: {}", e)))
}

#[tauri::command]
pub async fn agent_core_tokenize(args: TokenizeRequest) -> AppResult<serde_json::Value> {
    let (counts, fallback) = if args.mode.eq_ignore_ascii_case("heuristic") {
        (args.texts.iter().map(|t| fallback_count(t)).collect(), true)
    } else {
        let fb = crate::tokenize::bpe().is_none();
        (count_tokens_batch(&args.texts), fb)
    };
    to_value(TokenizeResponse { counts, fallback })
}

#[tauri::command]
pub async fn agent_core_compaction_plan(args: CompactionRequest) -> AppResult<serde_json::Value> {
    let plan = plan_compaction(
        &args.messages,
        &args.config,
        args.model_name.as_deref().unwrap_or("default"),
        args.overrides.as_ref(),
    );
    to_value(plan)
}

#[tauri::command]
pub async fn agent_core_cache_plan(args: CachePlanRequest) -> AppResult<serde_json::Value> {
    to_value(build_cache_plan(&args))
}

#[tauri::command]
pub async fn agent_core_skills_parse_frontmatter(
    args: FrontmatterRequest,
) -> AppResult<serde_json::Value> {
    to_value(parse_frontmatter_result(&args.content))
}

#[tauri::command]
pub async fn agent_core_cron_next(args: CronNextRequest) -> AppResult<serde_json::Value> {
    let parsed = parse_cron_expression(&args.expr);
    let next = if parsed.valid {
        parsed.next_after(args.after_ms)
    } else {
        None
    };
    let resp = CronNextResponse {
        valid: parsed.valid,
        normalized: parsed.normalized,
        next_after_ms: next,
    };
    to_value(resp)
}

#[tauri::command]
pub async fn agent_core_memory_graph_build(
    args: MemoryGraphRequest,
) -> AppResult<serde_json::Value> {
    to_value(build_memory_graph(&args))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::compaction::CompactionConfig;
    use crate::schema::graph::SessionEntry;
    use crate::schema::message::Message;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().unwrap()
    }

    #[test]
    fn tokenize_heuristic_returns_fallback_counts() {
        let req = TokenizeRequest {
            texts: vec!["abc".to_string()],
            mode: "heuristic".to_string(),
        };
        let v = rt().block_on(agent_core_tokenize(req)).unwrap();
        assert_eq!(v["counts"], serde_json::json!([1]));
        assert_eq!(v["fallback"], true);
    }

    #[test]
    fn cron_next_parses_every() {
        let req = CronNextRequest {
            expr: "@every 5m".to_string(),
            after_ms: 0,
        };
        let v = rt().block_on(agent_core_cron_next(req)).unwrap();
        assert_eq!(v["valid"], true);
        assert_eq!(v["nextAfterMs"], serde_json::json!(300_000));
    }

    #[test]
    fn cron_next_invalid_expression() {
        let req = CronNextRequest {
            expr: "garbage".to_string(),
            after_ms: 0,
        };
        let v = rt().block_on(agent_core_cron_next(req)).unwrap();
        assert_eq!(v["valid"], false);
        assert!(v.get("nextAfterMs").is_none());
    }

    #[test]
    fn compaction_plan_returns_compressible() {
        let msgs: Vec<Message> = (0..12)
            .map(|i| Message {
                role: if i % 2 == 0 { "user" } else { "assistant" }.to_string(),
                content: Some(serde_json::json!("some content to estimate tokens")),
                ..Default::default()
            })
            .collect();
        let req = CompactionRequest {
            messages: msgs,
            config: CompactionConfig {
                enabled: true,
                context_length: 100,
                threshold: 0.5,
                protect_first_n: 2,
                protect_last_n: 2,
                min_tail_user_messages: 1,
                summary_budget: 1_000,
                ..Default::default()
            },
            model_name: Some("test".to_string()),
            overrides: None,
        };
        let v = rt().block_on(agent_core_compaction_plan(req)).unwrap();
        assert_eq!(v["status"], "compressible");
        assert!(v["range"].is_object());
    }

    #[test]
    fn memory_graph_build_returns_nodes_and_edges() {
        let req = MemoryGraphRequest {
            memory_entries: vec![crate::schema::graph::MemoryEntry {
                id: String::new(),
                content: "javascript testing library".to_string(),
                importance: 0.5,
                scope: "memory".to_string(),
            }],
            sessions: vec![SessionEntry {
                id: "s1".to_string(),
                title: "javascript testing".to_string(),
                preview: None,
                source: None,
                started_at: 0,
                message_count: 1,
                tool_call_count: 0,
            }],
            max_edges_per_node: Some(4),
            min_edge_score: None,
        };
        let v = rt().block_on(agent_core_memory_graph_build(req)).unwrap();
        assert!(v["stats"]["nodeCount"].as_u64().unwrap() >= 2);
        assert!(v["stats"]["memoryCount"].as_u64().unwrap() >= 1);
    }
}
