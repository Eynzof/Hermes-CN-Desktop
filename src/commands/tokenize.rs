//! Tauri IPC wrappers for the shared `src/tokenize` core.
//!
//! Registration in `src/main.rs` (via `generate_handler!`) is performed by a
//! separate task; these functions are the command bodies.

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::schema::tool::ToolDefinition;
use crate::tokenize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenizeCountInput {
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenizeCountOutput {
    pub count: usize,
}

/// `tokenize_count` — count tokens for a single debug string.
#[tauri::command]
pub fn tokenize_count(input: TokenizeCountInput) -> AppResult<TokenizeCountOutput> {
    Ok(TokenizeCountOutput {
        count: tokenize::count_tokens(&input.text),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenizeEstimateToolSetInput {
    pub defs: Vec<ToolDefinition>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenizeEstimateToolSetOutput {
    pub total: usize,
}

/// `tokenize_estimate_tool_set` — estimate the token cost of a tool set.
#[tauri::command]
pub fn tokenize_estimate_tool_set(
    input: TokenizeEstimateToolSetInput,
) -> AppResult<TokenizeEstimateToolSetOutput> {
    // `tokenize::estimate_tool_tokens` reads the flat `{name, description,
    // parameters}` tool shape (matching `estimateToolTokens`), so we flatten the
    // nested `function` object before feeding the shared estimator.
    let defs: Vec<serde_json::Value> = input
        .defs
        .iter()
        .map(|d| {
            serde_json::json!({
                "name": d.function.name,
                "description": d.function.description,
                "parameters": d.function.parameters,
            })
        })
        .collect();
    Ok(TokenizeEstimateToolSetOutput {
        total: tokenize::estimate_tool_set_tokens(&defs),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_count_returns_count() {
        let out = tokenize_count(TokenizeCountInput {
            text: "hello".to_string(),
        })
        .unwrap();
        assert!(out.count >= 1);
    }

    #[test]
    fn tokenize_estimate_tool_set_sums() {
        let input = TokenizeEstimateToolSetInput {
            defs: vec![ToolDefinition {
                r#type: "function".to_string(),
                function: crate::schema::tool::ToolFunction {
                    name: "todo".to_string(),
                    description: "Manage a todo list.".to_string(),
                    parameters: crate::schema::tool::ToolParameterSchema {
                        r#type: "object".to_string(),
                        properties: Some(Default::default()),
                        required: None,
                        additional_properties: Some(serde_json::Value::Bool(false)),
                        extra: Default::default(),
                    },
                },
            }],
        };
        let out = tokenize_estimate_tool_set(input).unwrap();
        assert!(out.total > 0);
    }
}
