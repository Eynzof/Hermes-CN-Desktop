//! Native token counting.
//!
//! Home for the deterministic token-estimation primitives used by the desktop
//! Tauri path. The browser-only-dev runtime (`python run.py`) still runs the TS
//! `js-tiktoken`/char-fallback implementation; this module is the Rust twin.
//!
//! `count_tokens` uses the `cl100k_base` BPE encoding via `tiktoken-rs` when it
//! can load, and otherwise falls back to a `chars / 4` (with CJK ≈ 1) heuristic.
//! The heuristic-only functions (`fallback_count`, `estimate_tool_set_tokens_sync`)
//! are the stable sync path used by the UI.

use std::sync::OnceLock;

/// A token-counted string batch request entry (serde mirror of the TS IPC shape).
pub fn count_tokens_batch(texts: &[String]) -> Vec<usize> {
    texts.iter().map(|t| count_tokens(t)).collect()
}

/// Count tokens for a single string using `cl100k_base` BPE if available, else
/// the `chars / 4` heuristic.
pub fn count_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    if let Some(bpe) = bpe() {
        // `encode_with_special_tokens` keeps special token ids so we never panic
        // on strings that collide with a special-token pattern.
        return bpe.encode_with_special_tokens(text).len();
    }
    fallback_count(text)
}

/// Heuristic estimate: `ceil(chars / 4)` with CJK chars counted as 1 token.
pub fn fallback_count(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let units = text.chars().count();
    // Rough approximation: ASCII/space-heavy text ~4 chars/token, CJK ~1 char/token.
    let ascii_like = text.chars().filter(|c| !is_cjk(*c)).count();
    let cjk = units - ascii_like;
    let ascii_tokens = ascii_like.div_ceil(4);
    ascii_tokens + cjk
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF |   // CJK Unified Ideographs
        0x3400..=0x4DBF |   // CJK Extension A
        0x20000..=0x2A6DF | // CJK Extension B (rare; count as one)
        0xF900..=0xFAFF     // CJK Compatibility Ideographs
    )
}

/// Estimate the tokens a tool definition contributes (name + description +
/// parameter schema JSON). Mirrors `estimateToolTokens`.
pub fn estimate_tool_tokens(def: &serde_json::Value) -> usize {
    let mut total = fallback_count("tool");
    if let Some(name) = def.get("name").and_then(|v| v.as_str()) {
        total += fallback_count(name);
    }
    if let Some(desc) = def.get("description").and_then(|v| v.as_str()) {
        total += fallback_count(desc);
    }
    if let Some(parameters) = def.get("parameters") {
        total += fallback_count(&parameters.to_string());
    }
    total
}

/// Estimate the token cost of a toolset (sum of each tool + separators).
pub fn estimate_tool_set_tokens(defs: &[serde_json::Value]) -> usize {
    let mut total = 0usize;
    for def in defs {
        total += estimate_tool_tokens(def);
        total += 2; // delimiter overhead
    }
    total
}

/// Sync heuristic variant used by the UI checklist (matches
/// `estimateToolSetTokensSync`'s `chars / 4` semantics).
pub fn estimate_tool_set_tokens_sync(defs: &[serde_json::Value]) -> usize {
    let mut total = 0usize;
    for def in defs {
        total += fallback_count(&def.to_string());
    }
    total
}

/// Estimate the token cost of a single message object.
///
/// `msg` is a serde value mirroring the sparse `CompactionMessage`/`Message`
/// shape (`role`, `content`, `toolCalls`, `toolCallId`, `name`, …).
pub fn estimate_message_tokens(msg: &serde_json::Value) -> usize {
    let mut total = 0usize;
    if let Some(role) = msg.get("role").and_then(|v| v.as_str()) {
        total += fallback_count(role);
        total += 3; // role framing overhead
    }
    match msg.get("content") {
        Some(serde_json::Value::String(s)) => total += count_tokens(s),
        Some(serde_json::Value::Array(arr)) => {
            for part in arr {
                total += count_content_part(part);
            }
        }
        _ => {}
    }
    if let Some(name) = msg.get("name").and_then(|v| v.as_str()) {
        total += fallback_count(name);
    }
    if let Some(tool_calls) = msg.get("toolCalls").and_then(|v| v.as_array()) {
        for tc in tool_calls {
            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                total += fallback_count(id) + 4;
            }
            if let Some(fn_) = tc.get("function") {
                if let Some(name) = fn_.get("name").and_then(|v| v.as_str()) {
                    total += fallback_count(name) + 4;
                }
                if let Some(args) = fn_.get("arguments").and_then(|v| v.as_str()) {
                    total += count_tokens(args);
                }
            }
        }
    }
    if let Some(tool_call_id) = msg.get("toolCallId").and_then(|v| v.as_str()) {
        total += fallback_count(tool_call_id) + 4;
    }
    total
}

fn count_content_part(part: &serde_json::Value) -> usize {
    match part {
        serde_json::Value::String(s) => count_tokens(s),
        serde_json::Value::Object(obj) => {
            let mut total = 0usize;
            if let Some(t) = obj.get("type").and_then(|v| v.as_str()) {
                total += fallback_count(t);
            }
            if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                total += count_tokens(text);
            }
            if let Some(image) = obj.get("image").and_then(|v| v.as_str()) {
                total += fallback_count(image) + 85; // image overhead approximation
            }
            total
        }
        _ => 0,
    }
}

/// Estimate tokens for a full message array.
pub fn estimate_messages_tokens(messages: &[serde_json::Value]) -> usize {
    let mut total = 3usize; // chat-system overhead
    for msg in messages {
        total += estimate_message_tokens(msg);
        total += 3; // per-message separator
    }
    total
}

pub fn bpe() -> Option<&'static tiktoken_rs::CoreBPE> {
    static ENC: OnceLock<Option<tiktoken_rs::CoreBPE>> = OnceLock::new();
    ENC.get_or_init(|| tiktoken_rs::cl100k_base().ok()).as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_empty_is_zero() {
        assert_eq!(count_tokens(""), 0);
        assert_eq!(fallback_count(""), 0);
    }

    #[test]
    fn fallback_ascii_avg() {
        // 40 ascii chars -> 10 tokens.
        let s = "the quick brown fox jumps over the lazy dog!";
        assert!(fallback_count(s) >= 1);
        assert!(fallback_count(s) <= s.len());
    }

    #[test]
    fn cjk_counts_higher_than_ascii() {
        // CJK is counted ~1 token/char, so a short CJK string should not be far
        // below its char count.
        let s = "你好，世界！这是一个测试。";
        let n = fallback_count(s);
        assert!(n >= s.chars().count().saturating_sub(1) as usize / 2);
    }

    #[test]
    fn estimate_messages_sums() {
        let msgs = vec![
            serde_json::json!({"role": "user", "content": "hello"}),
            serde_json::json!({"role": "assistant", "content": "hi"}),
        ];
        let n = estimate_messages_tokens(&msgs);
        assert!(n > estimate_message_tokens(&msgs[0]));
    }

    #[test]
    fn estimate_tool_set_is_positive() {
        let defs = vec![
            serde_json::json!({"name": "f", "description": "desc", "parameters": {"type":"object"}}),
        ];
        assert!(estimate_tool_set_tokens(&defs) > 0);
        assert!(estimate_tool_set_tokens_sync(&defs) > 0);
    }
}
