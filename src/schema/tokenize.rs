//! Serde types for the native token-counting IPC boundary.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenizeRequest {
    #[serde(default)]
    pub texts: Vec<String>,
    /// `"bpe"` (native cl100k_base via tiktoken-rs) or `"heuristic"` (chars/4 + CJK≈1).
    #[serde(default = "default_mode")]
    pub mode: String,
}

fn default_mode() -> String {
    "bpe".to_string()
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenizeResponse {
    pub counts: Vec<usize>,
    pub fallback: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_defaults_to_bpe() {
        let req: TokenizeRequest =
            serde_json::from_value(serde_json::json!({ "texts": ["hi"] })).unwrap();
        assert_eq!(req.mode, "bpe");
        assert_eq!(req.texts, vec!["hi".to_string()]);
    }

    #[test]
    fn response_serializes_camel() {
        let resp = TokenizeResponse {
            counts: vec![1, 2],
            fallback: false,
        };
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["counts"], serde_json::json!([1, 2]));
        assert_eq!(v["fallback"], false);
    }
}
