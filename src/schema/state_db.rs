//! Schema home for the `state_db` IPC request/response structs.
//!
//! The canonical definitions live in `src/state_db.rs` (that file is owned by a
//! concurrent task and is outside this sub-agent's edit set). This module
//! re-exports them so the command layer can address them as
//! `crate::schema::state_db::*` — the single-source-of-truth home — without
//! duplicating the structs. Unit tests here lock the serde round-trip for the
//! types we surface.

pub use crate::state_db::{StateDbFtsSearchRequest, StateDbQueryRequest, StateDbSearchMeta};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_db_query_request_round_trips() {
        let v = serde_json::json!({
            "sql": "SELECT * FROM messages LIMIT 1",
            "params": ["a", 1, null],
            "readonly": true
        });
        let req: StateDbQueryRequest = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(req.sql, "SELECT * FROM messages LIMIT 1");
        assert_eq!(req.readonly, true);
        assert_eq!(serde_json::to_value(&req).unwrap(), v);
    }

    #[test]
    fn state_db_query_request_defaults() {
        let req: StateDbQueryRequest = serde_json::from_value(serde_json::json!({
            "sql": "SELECT 1"
        }))
        .unwrap();
        assert!(req.readonly); // readonly defaults true
        assert!(req.params.is_empty()); // params defaults []
    }

    #[test]
    fn state_db_fts_search_request_defaults_params_empty() {
        let req: StateDbFtsSearchRequest =
            serde_json::from_value(serde_json::json!({ "sql": "SELECT 1" })).unwrap();
        assert!(req.params.is_empty());
    }

    #[test]
    fn state_db_search_meta_null_vs_missing() {
        let v = serde_json::json!({
            "schemaVersion": 25,
            "ftsStorageVersion": 1,
            "ftsStale": false,
            "ftsCjkStale": false,
            "rowCountMessages": 10,
            "rowCountSessions": 2
        });
        let meta: StateDbSearchMeta = serde_json::from_value(v).unwrap();
        assert_eq!(meta.schema_version, 25);
        assert!(meta.fts_rebuild_high_water.is_none());
        assert_eq!(meta.row_count_messages, 10);
    }
}
