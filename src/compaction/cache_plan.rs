//! Deterministic prompt-cache planning (Anthropic ≤4 breakpoints) + cache key.
//!
//! Mirrors `packages/agent-core/src/compaction/prompt-cache.ts` `buildPromptCachePlan`
//! and `buildCacheKey`. The stateful stable-prefix registry stays TS; the matched
//! `staticSystemPrefix` / breakpoint hint is passed into the Rust call.

use crate::schema::compaction::{CachePlan, CachePlanRequest};
use crate::schema::message::Message;

pub const DEFAULT_CACHE_TTL: &str = "1h";
pub const MAX_BREAKPOINTS: usize = 4;
pub const TTL_MS_5M: i64 = 5 * 60 * 1000;
pub const TTL_MS_1H: i64 = 60 * 60 * 1000;

pub fn is_anthropic_provider(provider: &str) -> bool {
    provider == "anthropic" || provider == "openrouter"
}

fn ttl_ms(cache_ttl: Option<&str>) -> i64 {
    match cache_ttl {
        Some("5m") => TTL_MS_5M,
        _ => TTL_MS_1H,
    }
}

fn is_cacheable_message(message: &Message) -> bool {
    match message.role.as_str() {
        "system" => true,
        "user" | "assistant" => match message.content.as_ref() {
            Some(serde_json::Value::String(s)) => !s.trim().is_empty(),
            Some(_) => true, // array content is cacheable
            None => false,   // `message.content ?? ""` -> empty string
        },
        _ => false,
    }
}

/// Build a cache plan with at most `MAX_BREAKPOINTS` breakpoints.
pub fn build_cache_plan(request: &CachePlanRequest) -> CachePlan {
    let provider = request.provider.as_str();
    let ttl = ttl_ms(request.cache_ttl.as_deref());

    if !is_anthropic_provider(provider) {
        return CachePlan {
            message_breakpoints: Vec::new(),
            tool_breakpoints: Vec::new(),
            breakpoint_count: 0,
            ttl_ms: ttl,
        };
    }

    let mut message_breakpoints: Vec<usize> = Vec::new();

    // 1. Static system prefix marker (stable across sessions).
    if let Some(prefix) = request.static_system_prefix.as_deref() {
        if !prefix.trim().is_empty() {
            message_breakpoints.push(0);
        }
    }

    // 2. Full system prompt marker — latest system message.
    let mut system_index: Option<usize> = None;
    for (i, m) in request.messages.iter().enumerate().rev() {
        if m.role == "system" {
            system_index = Some(i);
            break;
        }
    }
    if let Some(idx) = system_index {
        if !message_breakpoints.contains(&idx) {
            message_breakpoints.push(idx);
        }
    }

    // 3/4. Last cacheable non-system messages (from the end).
    let mut non_system_indexes: Vec<usize> = Vec::new();
    for (i, m) in request.messages.iter().enumerate().rev() {
        if m.role != "system" && is_cacheable_message(m) {
            if !message_breakpoints.contains(&i) {
                non_system_indexes.push(i);
            }
            if non_system_indexes.len() >= 2 {
                break;
            }
        }
    }

    if non_system_indexes.len() >= 2 {
        message_breakpoints.push(non_system_indexes[1]);
    }
    if let Some(&first) = non_system_indexes.first() {
        message_breakpoints.push(first);
    }

    let tool_breakpoints: Vec<usize> = Vec::new();
    let trimmed: Vec<usize> = message_breakpoints
        .iter()
        .take(MAX_BREAKPOINTS)
        .copied()
        .collect();
    let breakpoint_count = trimmed.len() + tool_breakpoints.len();

    CachePlan {
        message_breakpoints: trimmed,
        tool_breakpoints,
        breakpoint_count,
        ttl_ms: ttl,
    }
}

/// Opaque consistent cache key for a set of messages + tools.
pub fn build_cache_key(messages: &[Message], tools: Option<&[serde_json::Value]>) -> String {
    let message_values: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let mut map = serde_json::Map::new();
            map.insert(
                "role".to_string(),
                serde_json::Value::String(m.role.clone()),
            );
            if let Some(content) = &m.content {
                map.insert("content".to_string(), content.clone());
            }
            if let Some(tool_calls) = &m.tool_calls {
                let calls: Vec<serde_json::Value> = tool_calls
                    .iter()
                    .map(|tc| serde_json::to_value(tc).unwrap_or(serde_json::Value::Null))
                    .collect();
                map.insert("tool_calls".to_string(), serde_json::Value::Array(calls));
            }
            serde_json::Value::Object(map)
        })
        .collect();

    let tool_values: Vec<serde_json::Value> = tools
        .unwrap_or(&[])
        .iter()
        .map(|t| {
            let mut map = serde_json::Map::new();
            if let Some(name) = t.get("name").and_then(|v| v.as_str()) {
                map.insert(
                    "name".to_string(),
                    serde_json::Value::String(name.to_string()),
                );
            }
            if let Some(desc) = t.get("description").and_then(|v| v.as_str()) {
                map.insert(
                    "description".to_string(),
                    serde_json::Value::String(desc.to_string()),
                );
            }
            serde_json::Value::Object(map)
        })
        .collect();

    let payload = serde_json::json!({
        "messages": message_values,
        "tools": tool_values,
    });
    serde_json::to_string(&payload).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::message::Message;

    fn make_messages(count: usize) -> Vec<Message> {
        (0..count)
            .map(|i| Message {
                id: Some(format!("m{}", i)),
                role: if i % 2 == 0 {
                    "user".to_string()
                } else {
                    "assistant".to_string()
                },
                content: Some(serde_json::Value::String(format!("Message {}", i))),
                ..Default::default()
            })
            .collect()
    }

    fn req(provider: &str) -> CachePlanRequest {
        CachePlanRequest {
            messages: make_messages(6),
            tools: None,
            provider: provider.to_string(),
            cache_ttl: None,
            static_system_prefix: None,
        }
    }

    #[test]
    fn empty_plan_for_generic_provider() {
        let plan = build_cache_plan(&req("generic"));
        assert!(plan.message_breakpoints.is_empty());
        assert!(plan.tool_breakpoints.is_empty());
        assert_eq!(plan.breakpoint_count, 0);
    }

    #[test]
    fn empty_plan_for_openai_provider() {
        let plan = build_cache_plan(&req("openai"));
        assert_eq!(plan.breakpoint_count, 0);
    }

    #[test]
    fn marks_system_and_last_two_for_anthropic() {
        let mut messages = vec![Message {
            role: "system".to_string(),
            content: Some(serde_json::Value::String("You are helpful.".to_string())),
            ..Default::default()
        }];
        messages.extend(make_messages(4));
        let message_count = messages.len();
        let plan = build_cache_plan(&CachePlanRequest {
            messages,
            tools: None,
            provider: "anthropic".to_string(),
            cache_ttl: None,
            static_system_prefix: None,
        });
        assert!(plan.message_breakpoints.contains(&0));
        assert!(plan.message_breakpoints.contains(&(message_count - 1)));
        assert!(plan.message_breakpoints.contains(&(message_count - 2)));
        assert!(plan.breakpoint_count <= MAX_BREAKPOINTS);
    }

    #[test]
    fn adds_static_prefix_marker() {
        let messages = make_messages(4);
        let plan = build_cache_plan(&CachePlanRequest {
            messages,
            tools: None,
            provider: "anthropic".to_string(),
            cache_ttl: None,
            static_system_prefix: Some("STATIC_PREFIX".to_string()),
        });
        assert!(plan.message_breakpoints.contains(&0));
        assert!(plan.breakpoint_count <= MAX_BREAKPOINTS);
    }

    #[test]
    fn uses_default_1h_ttl() {
        let plan = build_cache_plan(&req("anthropic"));
        assert_eq!(plan.ttl_ms, TTL_MS_1H);
    }

    #[test]
    fn respects_5m_ttl() {
        let mut r = req("anthropic");
        r.cache_ttl = Some("5m".to_string());
        let plan = build_cache_plan(&r);
        assert_eq!(plan.ttl_ms, TTL_MS_5M);
    }

    #[test]
    fn never_exceeds_max_breakpoints() {
        let mut messages = vec![
            Message {
                role: "system".to_string(),
                content: Some(serde_json::Value::String("prefix".to_string())),
                ..Default::default()
            },
            Message {
                role: "system".to_string(),
                content: Some(serde_json::Value::String("prompt".to_string())),
                ..Default::default()
            },
        ];
        messages.extend(make_messages(10));
        let plan = build_cache_plan(&CachePlanRequest {
            messages,
            tools: None,
            provider: "anthropic".to_string(),
            cache_ttl: None,
            static_system_prefix: Some("prefix".to_string()),
        });
        assert!(plan.breakpoint_count <= MAX_BREAKPOINTS);
    }

    #[test]
    fn cache_key_is_stable_and_changes_on_content() {
        let a = make_messages(3);
        let b = make_messages(3);
        assert_eq!(build_cache_key(&a, None), build_cache_key(&a, None));
        let mut b2 = b.clone();
        b2[0].content = Some(serde_json::Value::String("changed".to_string()));
        assert_ne!(build_cache_key(&b, None), build_cache_key(&b2, None));
    }
}
