//! Deterministic context-compaction planning.
//!
//! This is the pure, CPU-bound subset that the TS `compressSessionContext`
//! orchestration delegates to. It implements the same token estimator, config
//! resolution, range selection, tool-pair alignment and sanitization as
//! `packages/agent-core/src/compaction/compress.ts`, but never performs LLM
//! summarization or emits events (those stay TS).
//!
//! Canonical `messages` arrays are never mutated; all functions return fresh
//! vectors or just compute values.

pub mod cache_plan;

pub use cache_plan::{build_cache_key, build_cache_plan};

use crate::schema::compaction::{CompactionConfig, CompactionPlan, CompactionRange};
use crate::schema::message::Message;
use std::collections::HashSet;

/// Rough token estimator matching TS `estimateTokens`: ASCII ≈ 4 chars/token,
/// every non-ASCII code point ≈ 1 token, with a minimum of 1.
///
/// Mirror detail: JS `text.length` is a UTF-16 code-unit count, so a surrogate
/// pair (emoji) contributes one extra "ASCII" unit. We reproduce that with
/// `encode_utf16().count()`.
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let utf16_len = text.encode_utf16().count();
    let non_ascii = text.chars().filter(|c| (*c as u32) > 127).count();
    let ascii = utf16_len - non_ascii;
    let ascii_tokens = ascii.div_ceil(4);
    std::cmp::max(1, ascii_tokens + non_ascii)
}

/// Estimate the token cost of a single message (TS `estimateMessageTokens`).
pub fn estimate_message_tokens(message: &Message) -> usize {
    let mut total = 3; // per-message overhead
    if let Some(serde_json::Value::String(content)) = message.content.as_ref() {
        total += estimate_tokens(content);
    }
    if let Some(tool_calls) = &message.tool_calls {
        for tc in tool_calls {
            total += estimate_tokens(&tc.name);
            let args_json = serde_json::to_string(&tc.arguments).unwrap_or_default();
            total += estimate_tokens(&args_json);
        }
    }
    total
}

/// Sum the token estimate for a message list.
pub fn estimate_messages_tokens(messages: &[Message]) -> usize {
    messages.iter().map(estimate_message_tokens).sum()
}

/// Resolve an effective config by applying model/provider substring overrides
/// (longest match wins), mirroring TS `resolveCompactionConfig`.
pub fn resolve_compaction_config(
    base: &CompactionConfig,
    model_name: &str,
    overrides: Option<&serde_json::Value>,
) -> CompactionConfig {
    let mut best_key = "";
    let mut matched = serde_json::Value::Null;
    if let Some(overrides) = overrides {
        if let Some(obj) = overrides.as_object() {
            for (key, value) in obj {
                if model_name.contains(key.as_str()) && key.len() > best_key.len() {
                    best_key = key;
                    matched = value.clone();
                }
            }
        }
    }
    let mut cfg = base.clone();
    cfg.apply_partial(&matched);
    cfg
}

/// True when `messages` exceed the threshold for the resolved config.
pub fn should_compress(messages: &[Message], config: &CompactionConfig) -> bool {
    if !config.enabled {
        return false;
    }
    let threshold_tokens = (config.threshold * config.context_length as f64).floor() as usize;
    estimate_messages_tokens(messages) > threshold_tokens
}

/// The compressible slice of a message list after protecting head/tail.
#[derive(Debug, Clone, PartialEq)]
pub struct CompressibleRange {
    pub start: usize,
    pub end: usize,
    pub protected_head: Vec<Message>,
}

/// Select the oldest compressible slice after `protectFirstN`, then apply tail
/// protection (TS `selectCompressibleRange`).
pub fn select_compressible_range(
    messages: &[Message],
    config: &CompactionConfig,
) -> CompressibleRange {
    let non_system_indexes: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role != "system")
        .map(|(i, _)| i)
        .collect();

    let protected_count = std::cmp::min(config.protect_first_n, non_system_indexes.len());
    let protected_head_indexes: HashSet<usize> = non_system_indexes
        .iter()
        .take(protected_count)
        .copied()
        .collect();
    let protected_head: Vec<Message> = messages
        .iter()
        .enumerate()
        .filter(|(idx, _)| protected_head_indexes.contains(idx))
        .map(|(_, m)| m.clone())
        .collect();

    let remaining_start = if protected_count == 0 {
        0
    } else {
        non_system_indexes[protected_count - 1] + 1
    };

    let mut tail_start = messages.len();
    let mut kept = 0usize;
    let mut user_kept = 0usize;
    let mut i = messages.len() as isize - 1;
    while i >= remaining_start as isize {
        let m = &messages[i as usize];
        if m.role == "system" {
            i -= 1;
            continue;
        }
        if kept >= config.protect_last_n && user_kept >= config.min_tail_user_messages {
            tail_start = i as usize + 1;
            break;
        }
        kept += 1;
        if m.role == "user" {
            user_kept += 1;
        }
        i -= 1;
    }

    CompressibleRange {
        start: remaining_start,
        end: tail_start,
        protected_head,
    }
}

/// Expand a compressed range to keep tool_call / tool_result pairs intact
/// (TS `alignBoundaryToToolPairs`).
pub fn align_boundary_to_tool_pairs(
    messages: &[Message],
    start: usize,
    end: usize,
) -> (usize, usize) {
    let mut tool_call_ids: HashSet<String> = HashSet::new();
    for m in &messages[start..end] {
        if m.role == "assistant" {
            if let Some(tool_calls) = &m.tool_calls {
                for tc in tool_calls {
                    if let Some(id) = &tc.id {
                        tool_call_ids.insert(id.clone());
                    }
                }
            }
        }
    }

    let mut aligned_start = start;
    let mut i = start as isize - 1;
    while i >= 0 {
        let m = &messages[i as usize];
        if m.role == "tool" {
            if let Some(cid) = &m.tool_call_id {
                if tool_call_ids.contains(cid) {
                    aligned_start = i as usize;
                } else {
                    break;
                }
            } else {
                break;
            }
        } else {
            break;
        }
        i -= 1;
    }

    let mut aligned_end = end;
    let mut j = end;
    while j < messages.len() {
        let m = &messages[j];
        if m.role == "tool" {
            if let Some(cid) = &m.tool_call_id {
                if tool_call_ids.contains(cid) {
                    aligned_end = j + 1;
                } else {
                    break;
                }
            } else {
                break;
            }
        } else {
            break;
        }
        j += 1;
    }

    (aligned_start, aligned_end)
}

/// Remove trailing `tool` messages whose owning `tool_call` is gone
/// (TS `sanitizeToolPairs`). Used by the TS summarizer orchestrator for the
/// kept tail; exposed here for parity.
pub fn sanitize_tool_pairs(messages: &[Message]) -> Vec<Message> {
    let mut tool_call_ids: HashSet<String> = HashSet::new();
    for m in messages {
        if m.role == "assistant" {
            if let Some(tool_calls) = &m.tool_calls {
                for tc in tool_calls {
                    if let Some(id) = &tc.id {
                        tool_call_ids.insert(id.clone());
                    }
                }
            }
        }
    }
    messages
        .iter()
        .filter(|m| {
            if m.role != "tool" {
                return true;
            }
            match &m.tool_call_id {
                Some(id) => tool_call_ids.contains(id),
                None => true,
            }
        })
        .cloned()
        .collect()
}

/// Deterministic compaction plan (no LLM call, no I/O). Returns a `noop` plan
/// when compaction is disabled, below threshold, or the aligned slice is empty;
/// otherwise returns a `compressible` plan with the target range + budget.
pub fn plan_compaction(
    messages: &[Message],
    config: &CompactionConfig,
    model_name: &str,
    overrides: Option<&serde_json::Value>,
) -> CompactionPlan {
    let config = resolve_compaction_config(config, model_name, overrides);
    let before_tokens = estimate_messages_tokens(messages);
    let threshold_tokens = (config.threshold * config.context_length as f64).floor() as usize;

    if !config.enabled || before_tokens <= threshold_tokens {
        return CompactionPlan {
            status: "noop".to_string(),
            before_tokens,
            threshold_tokens,
            range: None,
            compact_slice_tokens: 0,
            budget_tokens: 0,
        };
    }

    let range = select_compressible_range(messages, &config);
    let (aligned_start, aligned_end) =
        align_boundary_to_tool_pairs(messages, range.start, range.end);
    let compact_slice = &messages[aligned_start..aligned_end];

    if compact_slice.is_empty() {
        return CompactionPlan {
            status: "noop".to_string(),
            before_tokens,
            threshold_tokens,
            range: None,
            compact_slice_tokens: 0,
            budget_tokens: 0,
        };
    }

    let compact_slice_tokens = estimate_messages_tokens(compact_slice);
    let budget_tokens = std::cmp::max(
        2_000,
        std::cmp::min(
            config.summary_budget,
            ((compact_slice_tokens as f64) * 0.2).floor() as usize,
        ),
    );

    CompactionPlan {
        status: "compressible".to_string(),
        before_tokens,
        threshold_tokens,
        range: Some(CompactionRange {
            start: aligned_start,
            end: aligned_end,
        }),
        compact_slice_tokens,
        budget_tokens,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::message::ToolCall;

    fn config(ctx: usize) -> CompactionConfig {
        CompactionConfig {
            enabled: true,
            context_length: ctx,
            threshold: 0.5,
            target_ratio: 0.2,
            protect_first_n: 2,
            protect_last_n: 2,
            min_tail_user_messages: 1,
            summary_budget: 1_000,
            timeout_ms: 5_000,
            cooldown_ms: 1_000,
        }
    }

    fn make_messages(count: usize) -> Vec<Message> {
        (0..count)
            .map(|i| Message {
                id: Some(format!("m{}", i)),
                role: if i % 2 == 0 {
                    "user".to_string()
                } else {
                    "assistant".to_string()
                },
                content: Some(serde_json::Value::String(format!(
                    "Message {} with enough text to consume some tokens when estimated.",
                    i
                ))),
                timestamp: Some(i as i64),
                ..Default::default()
            })
            .collect()
    }

    #[test]
    fn estimate_ascii_about_4_chars_per_token() {
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcdefghijklmnopqrstuvwxyz"), 7);
    }

    #[test]
    fn estimate_cjk_one_token_per_char() {
        assert_eq!(estimate_tokens("你好世界"), 4);
    }

    #[test]
    fn estimate_emoji_surrogate_pair() {
        // JS UTF-16 length = 2, non-ascii code points = 1 -> ceil(1/4)+1 = 2.
        assert_eq!(estimate_tokens("😀"), 2);
    }

    #[test]
    fn estimate_message_tokens_with_overhead() {
        let m = Message {
            role: "user".to_string(),
            content: Some(serde_json::json!("hello")),
            ..Default::default()
        };
        assert!(estimate_message_tokens(&m) > 3);
    }

    #[test]
    fn should_compress_true_when_above_threshold() {
        let messages = make_messages(50);
        let cfg = config(100);
        assert!(should_compress(&messages, &cfg));
    }

    #[test]
    fn should_compress_false_when_disabled() {
        let messages = make_messages(10);
        let mut cfg = config(100);
        cfg.enabled = false;
        assert!(!should_compress(&messages, &cfg));
    }

    #[test]
    fn resolve_override_longest_match_wins() {
        let base = config(10_000);
        let overrides = serde_json::json!({
            "small": { "threshold": 0.75 },
            "gpt-4": { "threshold": 0.3 }
        });
        let resolved = resolve_compaction_config(&base, "openai/gpt-4-turbo", Some(&overrides));
        assert_eq!(resolved.threshold, 0.3);
    }

    #[test]
    fn select_range_protects_head_and_tail() {
        let messages = make_messages(20);
        let range = select_compressible_range(&messages, &config(200));
        assert!(range.end >= range.start);
        assert!(range.start <= 20);
    }

    #[test]
    fn align_tool_pairs_expands_backward() {
        let messages = vec![
            Message {
                role: "user".to_string(),
                content: Some(serde_json::json!("call tool")),
                ..Default::default()
            },
            Message {
                role: "assistant".to_string(),
                content: Some(serde_json::json!("")),
                tool_calls: Some(vec![ToolCall {
                    id: Some("tc1".to_string()),
                    name: "get_weather".to_string(),
                    arguments: serde_json::json!({"city": "Shanghai"}),
                    arguments_json: None,
                }]),
                ..Default::default()
            },
            Message {
                role: "tool".to_string(),
                content: Some(serde_json::json!("sunny")),
                tool_call_id: Some("tc1".to_string()),
                tool_name: Some("get_weather".to_string()),
                ..Default::default()
            },
            Message {
                role: "user".to_string(),
                content: Some(serde_json::json!("more")),
                ..Default::default()
            },
            Message {
                role: "assistant".to_string(),
                content: Some(serde_json::json!("ok")),
                ..Default::default()
            },
        ];
        let (_start, end) = align_boundary_to_tool_pairs(&messages, 1, 2);
        // tool_call in range at index 1; its tool_result at index 2 is outside by default,
        // but the forward expansion pulls it in.
        assert!(end >= 3);
    }

    #[test]
    fn sanitize_tool_pairs_drops_orphan_tool_results() {
        let messages = vec![
            Message {
                role: "assistant".to_string(),
                tool_calls: Some(vec![ToolCall {
                    id: Some("tc1".to_string()),
                    name: "f".to_string(),
                    arguments: serde_json::json!({}),
                    arguments_json: None,
                }]),
                ..Default::default()
            },
            Message {
                role: "tool".to_string(),
                tool_call_id: Some("tc1".to_string()),
                ..Default::default()
            },
            Message {
                role: "tool".to_string(),
                tool_call_id: Some("orphan".to_string()),
                ..Default::default()
            },
        ];
        let out = sanitize_tool_pairs(&messages);
        assert_eq!(out.len(), 2);
        assert!(out
            .iter()
            .all(|m| m.tool_call_id.as_deref() != Some("orphan")));
    }

    #[test]
    fn plan_compaction_returns_compressible() {
        let messages = make_messages(12);
        let plan = plan_compaction(&messages, &config(100), "test", None);
        assert_eq!(plan.status, "compressible");
        assert!(plan.range.is_some());
        assert!(plan.budget_tokens >= 2_000);
    }

    #[test]
    fn plan_compaction_noop_when_below_threshold() {
        let messages = make_messages(4);
        let plan = plan_compaction(&messages, &config(10_000), "test", None);
        assert_eq!(plan.status, "noop");
        assert!(plan.range.is_none());
    }
}
