use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

const UI_DB_FILE: &str = "desktop-ui.sqlite";
const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiStoreSnapshot {
    pub kv: HashMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiStoreSetKvInput {
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiStoreRemoveKvInput {
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UiTurnStats {
    pub id: String,
    pub session_id: String,
    #[serde(default)]
    pub gateway_session_id: Option<String>,
    #[serde(default)]
    pub client_message_id: Option<String>,
    #[serde(default)]
    pub backend_message_id: Option<i64>,
    #[serde(default)]
    pub turn_index: Option<i64>,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub first_token_at: Option<i64>,
    #[serde(default)]
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub ttft_ms: Option<i64>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub tokens_input: Option<i64>,
    #[serde(default)]
    pub tokens_output: Option<i64>,
    #[serde(default)]
    pub tokens_total: Option<i64>,
    #[serde(default)]
    pub cache_read: Option<i64>,
    #[serde(default)]
    pub cache_write: Option<i64>,
    #[serde(default)]
    pub reasoning_tokens: Option<i64>,
    #[serde(default)]
    pub context_used: Option<i64>,
    #[serde(default)]
    pub context_max: Option<i64>,
    #[serde(default)]
    pub api_calls: Option<i64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub cost_status: Option<String>,
    #[serde(default)]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTurnStatsQuery {
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiEventInput {
    pub id: String,
    pub ts: i64,
    pub event_name: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub props: Option<Value>,
    #[serde(default)]
    pub app_version: Option<String>,
}

pub fn db_path(hermes_home: &str) -> PathBuf {
    Path::new(hermes_home).join(UI_DB_FILE)
}

fn sqlite_err(e: rusqlite::Error) -> AppError {
    AppError::Internal(format!("UI store sqlite error: {}", e))
}

fn json_err(e: serde_json::Error) -> AppError {
    AppError::Internal(format!("UI store json error: {}", e))
}

fn connect(hermes_home: &str) -> AppResult<Connection> {
    let path = db_path(hermes_home);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path).map_err(sqlite_err)?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(sqlite_err)?;
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(sqlite_err)?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS ui_schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ui_kv (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session_ui_state (
            session_id TEXT PRIMARY KEY,
            title_override TEXT,
            archived INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            tags_json TEXT,
            workspace_path TEXT,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS turn_stats (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            gateway_session_id TEXT,
            client_message_id TEXT,
            backend_message_id INTEGER,
            turn_index INTEGER,
            content_hash TEXT,
            metadata_json TEXT,
            model TEXT,
            provider TEXT,
            started_at INTEGER,
            first_token_at INTEGER,
            completed_at INTEGER,
            ttft_ms INTEGER,
            duration_ms INTEGER,
            tokens_input INTEGER,
            tokens_output INTEGER,
            tokens_total INTEGER,
            cache_read INTEGER,
            cache_write INTEGER,
            reasoning_tokens INTEGER,
            context_used INTEGER,
            context_max INTEGER,
            api_calls INTEGER,
            cost_usd REAL,
            cost_status TEXT,
            finish_reason TEXT,
            status TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_turn_stats_session ON turn_stats(session_id, completed_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_turn_stats_hash ON turn_stats(session_id, content_hash);

        CREATE TABLE IF NOT EXISTS ui_events (
            id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            session_id TEXT,
            event_name TEXT NOT NULL,
            source TEXT,
            props_json TEXT,
            app_version TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ui_events_ts ON ui_events(ts);
        CREATE INDEX IF NOT EXISTS idx_ui_events_name ON ui_events(event_name, ts);
        ",
    )
    .map_err(sqlite_err)?;

    conn.execute(
        "INSERT OR IGNORE INTO ui_schema_migrations(version, applied_at) VALUES(?, strftime('%s','now') * 1000)",
        params![SCHEMA_VERSION],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn clean_key(key: &str) -> AppResult<String> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::InvalidRequest("UI store key is empty".into()));
    }
    if key.len() > 256 {
        return Err(AppError::InvalidRequest("UI store key is too long".into()));
    }
    Ok(key.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn snapshot(hermes_home: &str) -> AppResult<UiStoreSnapshot> {
    let conn = connect(hermes_home)?;
    let mut stmt = conn
        .prepare("SELECT key, value_json FROM ui_kv ORDER BY key")
        .map_err(sqlite_err)?;
    let rows = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let raw: String = row.get(1)?;
            Ok((key, raw))
        })
        .map_err(sqlite_err)?;

    let mut kv = HashMap::new();
    for row in rows {
        let (key, raw) = row.map_err(sqlite_err)?;
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            kv.insert(key, value);
        }
    }
    Ok(UiStoreSnapshot { kv })
}

pub fn set_kv(hermes_home: &str, input: UiStoreSetKvInput) -> AppResult<()> {
    let key = clean_key(&input.key)?;
    let raw = serde_json::to_string(&input.value).map_err(json_err)?;
    let conn = connect(hermes_home)?;
    conn.execute(
        "INSERT INTO ui_kv(key, value_json, updated_at)
         VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
        params![key, raw, now_ms()],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

pub fn remove_kv(hermes_home: &str, input: UiStoreRemoveKvInput) -> AppResult<()> {
    let key = clean_key(&input.key)?;
    let conn = connect(hermes_home)?;
    conn.execute("DELETE FROM ui_kv WHERE key = ?", params![key])
        .map_err(sqlite_err)?;
    Ok(())
}

pub fn set_session_archived(hermes_home: &str, session_id: &str, archived: bool) -> AppResult<()> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(AppError::InvalidRequest("session id is empty".into()));
    }
    let conn = connect(hermes_home)?;
    conn.execute(
        "INSERT INTO session_ui_state(session_id, archived, updated_at)
         VALUES(?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET archived=excluded.archived, updated_at=excluded.updated_at",
        params![session_id, if archived { 1 } else { 0 }, now_ms()],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

pub fn read_archived_session_ids(hermes_home: &str) -> HashSet<String> {
    let Ok(conn) = connect(hermes_home) else {
        return HashSet::new();
    };
    let Ok(mut stmt) = conn.prepare("SELECT session_id FROM session_ui_state WHERE archived = 1")
    else {
        return HashSet::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return HashSet::new();
    };
    rows.filter_map(Result::ok).collect()
}

pub fn record_turn_stats(hermes_home: &str, mut stat: UiTurnStats) -> AppResult<()> {
    if stat.id.trim().is_empty() {
        return Err(AppError::InvalidRequest("turn stats id is empty".into()));
    }
    if stat.session_id.trim().is_empty() {
        return Err(AppError::InvalidRequest(
            "turn stats session id is empty".into(),
        ));
    }
    stat.created_at = Some(stat.created_at.unwrap_or_else(now_ms));
    let metadata_json = match &stat.metadata {
        Some(value) => Some(serde_json::to_string(value).map_err(json_err)?),
        None => None,
    };
    let conn = connect(hermes_home)?;
    conn.execute(
        "INSERT INTO turn_stats(
            id, session_id, gateway_session_id, client_message_id, backend_message_id,
            turn_index, content_hash, metadata_json, model, provider, started_at,
            first_token_at, completed_at, ttft_ms, duration_ms, tokens_input,
            tokens_output, tokens_total, cache_read, cache_write, reasoning_tokens,
            context_used, context_max, api_calls, cost_usd, cost_status,
            finish_reason, status, created_at
         ) VALUES(
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )
         ON CONFLICT(id) DO UPDATE SET
            session_id=excluded.session_id,
            gateway_session_id=excluded.gateway_session_id,
            client_message_id=excluded.client_message_id,
            backend_message_id=excluded.backend_message_id,
            turn_index=excluded.turn_index,
            content_hash=excluded.content_hash,
            metadata_json=excluded.metadata_json,
            model=excluded.model,
            provider=excluded.provider,
            started_at=excluded.started_at,
            first_token_at=excluded.first_token_at,
            completed_at=excluded.completed_at,
            ttft_ms=excluded.ttft_ms,
            duration_ms=excluded.duration_ms,
            tokens_input=excluded.tokens_input,
            tokens_output=excluded.tokens_output,
            tokens_total=excluded.tokens_total,
            cache_read=excluded.cache_read,
            cache_write=excluded.cache_write,
            reasoning_tokens=excluded.reasoning_tokens,
            context_used=excluded.context_used,
            context_max=excluded.context_max,
            api_calls=excluded.api_calls,
            cost_usd=excluded.cost_usd,
            cost_status=excluded.cost_status,
            finish_reason=excluded.finish_reason,
            status=excluded.status,
            created_at=excluded.created_at",
        params![
            stat.id,
            stat.session_id,
            stat.gateway_session_id,
            stat.client_message_id,
            stat.backend_message_id,
            stat.turn_index,
            stat.content_hash,
            metadata_json,
            stat.model,
            stat.provider,
            stat.started_at,
            stat.first_token_at,
            stat.completed_at,
            stat.ttft_ms,
            stat.duration_ms,
            stat.tokens_input,
            stat.tokens_output,
            stat.tokens_total,
            stat.cache_read,
            stat.cache_write,
            stat.reasoning_tokens,
            stat.context_used,
            stat.context_max,
            stat.api_calls,
            stat.cost_usd,
            stat.cost_status,
            stat.finish_reason,
            stat.status,
            stat.created_at,
        ],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn row_to_turn_stats(row: &rusqlite::Row<'_>) -> rusqlite::Result<UiTurnStats> {
    let metadata_raw: Option<String> = row.get("metadata_json")?;
    let metadata = metadata_raw
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    Ok(UiTurnStats {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        gateway_session_id: row.get("gateway_session_id")?,
        client_message_id: row.get("client_message_id")?,
        backend_message_id: row.get("backend_message_id")?,
        turn_index: row.get("turn_index")?,
        content_hash: row.get("content_hash")?,
        metadata,
        model: row.get("model")?,
        provider: row.get("provider")?,
        started_at: row.get("started_at")?,
        first_token_at: row.get("first_token_at")?,
        completed_at: row.get("completed_at")?,
        ttft_ms: row.get("ttft_ms")?,
        duration_ms: row.get("duration_ms")?,
        tokens_input: row.get("tokens_input")?,
        tokens_output: row.get("tokens_output")?,
        tokens_total: row.get("tokens_total")?,
        cache_read: row.get("cache_read")?,
        cache_write: row.get("cache_write")?,
        reasoning_tokens: row.get("reasoning_tokens")?,
        context_used: row.get("context_used")?,
        context_max: row.get("context_max")?,
        api_calls: row.get("api_calls")?,
        cost_usd: row.get("cost_usd")?,
        cost_status: row.get("cost_status")?,
        finish_reason: row.get("finish_reason")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
    })
}

pub fn get_turn_stats(hermes_home: &str, session_id: &str) -> AppResult<Vec<UiTurnStats>> {
    let conn = connect(hermes_home)?;
    let mut stmt = conn
        .prepare(
            "SELECT * FROM turn_stats
             WHERE session_id = ? OR gateway_session_id = ?
             ORDER BY COALESCE(completed_at, created_at), created_at, id",
        )
        .map_err(sqlite_err)?;
    let rows = stmt
        .query_map(params![session_id, session_id], row_to_turn_stats)
        .map_err(sqlite_err)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(sqlite_err)?);
    }
    Ok(out)
}

pub fn record_event(hermes_home: &str, input: UiEventInput) -> AppResult<()> {
    if input.id.trim().is_empty() || input.event_name.trim().is_empty() {
        return Err(AppError::InvalidRequest("UI event id/name is empty".into()));
    }
    let props_json = match &input.props {
        Some(value) => Some(serde_json::to_string(value).map_err(json_err)?),
        None => None,
    };
    let conn = connect(hermes_home)?;
    conn.execute(
        "INSERT OR REPLACE INTO ui_events(id, ts, session_id, event_name, source, props_json, app_version)
         VALUES(?, ?, ?, ?, ?, ?, ?)",
        params![
            input.id,
            input.ts,
            input.session_id,
            input.event_name,
            input.source,
            props_json,
            input.app_version,
        ],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

pub fn kv_value(hermes_home: &str, key: &str) -> AppResult<Option<Value>> {
    let conn = connect(hermes_home)?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM ui_kv WHERE key = ?",
            params![clean_key(key)?],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_err)?;
    raw.map(|value| serde_json::from_str::<Value>(&value).map_err(json_err))
        .transpose()
}

/// UI-store KV key holding the desktop "YOLO mode" preference, scoped to the
/// active profile's HERMES_HOME. When truthy, the desktop launches the managed
/// runtime with `HERMES_YOLO_MODE=1`, which makes the backend auto-approve
/// dangerous-command prompts (equivalent to the `--yolo` CLI flag).
pub const YOLO_MODE_KEY: &str = "desktop.yoloMode";

fn value_is_truthy(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_i64().map(|v| v != 0).unwrap_or(false),
        Value::String(s) => matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        _ => false,
    }
}

/// Read the persisted desktop YOLO-mode preference for `hermes_home`.
///
/// Returns `false` when the key is unset or on any read error — YOLO mode must
/// never be enabled by accident, so we fail closed.
pub fn yolo_mode_enabled(hermes_home: &str) -> bool {
    match kv_value(hermes_home, YOLO_MODE_KEY) {
        Ok(Some(value)) => value_is_truthy(&value),
        _ => false,
    }
}

/// Persist the desktop YOLO-mode preference for `hermes_home`.
pub fn set_yolo_mode(hermes_home: &str, enabled: bool) -> AppResult<()> {
    set_kv(
        hermes_home,
        UiStoreSetKvInput {
            key: YOLO_MODE_KEY.to_string(),
            value: Value::Bool(enabled),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    #[test]
    fn kv_roundtrip() {
        let dir = TempDir::new().unwrap();
        set_kv(
            dir.path().to_str().unwrap(),
            UiStoreSetKvInput {
                key: "hello".into(),
                value: serde_json::json!({ "world": true }),
            },
        )
        .unwrap();
        let snap = snapshot(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(snap.kv["hello"], serde_json::json!({ "world": true }));
    }

    #[test]
    fn archived_sessions_roundtrip() {
        let dir = TempDir::new().unwrap();
        set_session_archived(dir.path().to_str().unwrap(), "s1", true).unwrap();
        assert!(read_archived_session_ids(dir.path().to_str().unwrap()).contains("s1"));
        set_session_archived(dir.path().to_str().unwrap(), "s1", false).unwrap();
        assert!(!read_archived_session_ids(dir.path().to_str().unwrap()).contains("s1"));
    }

    #[test]
    fn yolo_mode_defaults_off_and_roundtrips() {
        let dir = TempDir::new().unwrap();
        let home = dir.path().to_str().unwrap();
        // Unset → fail closed.
        assert!(!yolo_mode_enabled(home));
        set_yolo_mode(home, true).unwrap();
        assert!(yolo_mode_enabled(home));
        set_yolo_mode(home, false).unwrap();
        assert!(!yolo_mode_enabled(home));
    }

    #[test]
    fn yolo_mode_reads_legacy_truthy_values() {
        let dir = TempDir::new().unwrap();
        let home = dir.path().to_str().unwrap();
        for raw in [
            serde_json::json!(1),
            serde_json::json!("1"),
            serde_json::json!("true"),
            serde_json::json!("on"),
        ] {
            set_kv(
                home,
                UiStoreSetKvInput {
                    key: YOLO_MODE_KEY.into(),
                    value: raw.clone(),
                },
            )
            .unwrap();
            assert!(yolo_mode_enabled(home), "expected truthy for {raw}");
        }
        for raw in [
            serde_json::json!(0),
            serde_json::json!("0"),
            serde_json::json!("false"),
            serde_json::json!(null),
        ] {
            set_kv(
                home,
                UiStoreSetKvInput {
                    key: YOLO_MODE_KEY.into(),
                    value: raw.clone(),
                },
            )
            .unwrap();
            assert!(!yolo_mode_enabled(home), "expected falsy for {raw}");
        }
    }

    #[test]
    fn turn_stats_roundtrip() {
        let dir = TempDir::new().unwrap();
        record_turn_stats(
            dir.path().to_str().unwrap(),
            UiTurnStats {
                id: "t1".into(),
                session_id: "s1".into(),
                content_hash: Some("h".into()),
                metadata: Some(serde_json::json!({ "usage": { "tokensTotal": 12 } })),
                tokens_total: Some(12),
                ..Default::default()
            },
        )
        .unwrap();
        let stats = get_turn_stats(dir.path().to_str().unwrap(), "s1").unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].tokens_total, Some(12));
        assert_eq!(
            stats[0].metadata.as_ref().unwrap()["usage"]["tokensTotal"],
            12
        );
    }
}
