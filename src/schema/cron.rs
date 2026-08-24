//! Serde types for the cron next-run IPC boundary.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CronNextRequest {
    pub expr: String,
    pub after_ms: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CronNextResponse {
    pub valid: bool,
    pub normalized: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_after_ms: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trips() {
        let req: CronNextRequest =
            serde_json::from_value(serde_json::json!({ "expr": "@hourly", "afterMs": 1000 }))
                .unwrap();
        assert_eq!(req.expr, "@hourly");
        assert_eq!(req.after_ms, 1000);
    }

    #[test]
    fn response_serializes_camel() {
        let resp = CronNextResponse {
            valid: true,
            normalized: "@hourly".into(),
            next_after_ms: Some(1000),
        };
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["valid"], true);
        assert_eq!(v["normalized"], "@hourly");
        assert_eq!(v["nextAfterMs"], 1000);
    }
}
