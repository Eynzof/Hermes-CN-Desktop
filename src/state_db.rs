//! SQLite state.db persistence and FTS5 search.
//!
//! Mirrors Hermes-CN-Core v25 schema (`sessions`, `messages`, `state_meta`) and
//! exposes narrow Tauri commands used by the TypeScript `SessionSearchEngine`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

const STATE_DB_FILE: &str = "state.db";
const SCHEMA_VERSION: i64 = 25;
const FTS_STORAGE_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateDbQueryRequest {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    #[serde(default = "default_readonly")]
    pub readonly: bool,
}

fn default_readonly() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateDbFtsSearchRequest {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StateDbSearchMeta {
    pub schema_version: i64,
    pub fts_storage_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fts_rebuild_high_water: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fts_rebuild_progress: Option<i64>,
    #[serde(default)]
    pub fts_stale: bool,
    #[serde(default)]
    pub fts_cjk_stale: bool,
    pub row_count_messages: i64,
    pub row_count_sessions: i64,
}

fn sqlite_err(e: rusqlite::Error) -> AppError {
    AppError::Internal(format!("state.db sqlite error: {}", e))
}

pub fn db_path(hermes_home: &str) -> PathBuf {
    Path::new(hermes_home).join(STATE_DB_FILE)
}

#[allow(dead_code)]
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn value_to_rusqlite(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rusqlite::types::Value::Integer(i)
            } else {
                rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        Value::Array(a) => {
            rusqlite::types::Value::Text(serde_json::to_string(a).unwrap_or_default())
        }
        Value::Object(o) => {
            rusqlite::types::Value::Text(serde_json::to_string(o).unwrap_or_default())
        }
    }
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
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS state_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            model TEXT,
            title TEXT,
            started_at INTEGER,
            ended_at INTEGER,
            parent_session_id TEXT,
            end_reason TEXT,
            archived INTEGER DEFAULT 0,
            metadata_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT,
            content TEXT,
            tool_name TEXT,
            tool_calls TEXT,
            timestamp INTEGER,
            active INTEGER DEFAULT 1,
            compacted INTEGER DEFAULT 0,
            observed INTEGER DEFAULT 0,
            metadata_json TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
        "
        .trim_start(),
    )
    .map_err(sqlite_err)?;

    let has_fts5: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if has_fts5 {
        create_fts_tables(conn)?;
        create_fts_triggers(conn)?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO schema_version(version) VALUES(?)",
        params![SCHEMA_VERSION],
    )
    .map_err(sqlite_err)?;

    Ok(())
}

fn create_fts_tables(conn: &Connection) -> AppResult<()> {
    // External-content FTS5 over raw content/tool_name/tool_calls.
    conn.execute_batch(
        "
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            tool_name,
            tool_calls,
            content='messages',
            content_rowid='id',
            tokenize='unicode61'
        );

        -- Trigram source view excludes tool rows.
        DROP VIEW IF EXISTS messages_fts_trigram_src;
        CREATE VIEW IF NOT EXISTS messages_fts_trigram_src AS
        SELECT id, content, tool_name, tool_calls
        FROM messages
        WHERE role IS NULL OR role != 'tool';

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
            content,
            tool_name,
            tool_calls,
            content='messages_fts_trigram_src',
            content_rowid='id',
            tokenize='trigram'
        );

        -- CJK bigram table: content is pre-bigrammed by TypeScript at write time.
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_cjk USING fts5(
            content,
            tool_name,
            tool_calls,
            content='messages',
            content_rowid='id',
            tokenize='unicode61'
        );
        "
        .trim_start(),
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn create_fts_triggers(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "
        -- Keep external-content FTS indexes in sync with messages.
        CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content, tool_name, tool_calls)
            VALUES (new.id, new.content, new.tool_name, new.tool_calls);
            INSERT INTO messages_fts_cjk(rowid, content, tool_name, tool_calls)
            VALUES (new.id, new.content, new.tool_name, new.tool_calls);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, tool_calls)
            VALUES ('delete', old.id, old.content, old.tool_name, old.tool_calls);
            INSERT INTO messages_fts_cjk(messages_fts_cjk, rowid, content, tool_name, tool_calls)
            VALUES ('delete', old.id, old.content, old.tool_name, old.tool_calls);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_fts_update
        AFTER UPDATE OF content, tool_name, tool_calls ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, tool_calls)
            VALUES ('delete', old.id, old.content, old.tool_name, old.tool_calls);
            INSERT INTO messages_fts(rowid, content, tool_name, tool_calls)
            VALUES (new.id, new.content, new.tool_name, new.tool_calls);
            INSERT INTO messages_fts_cjk(messages_fts_cjk, rowid, content, tool_name, tool_calls)
            VALUES ('delete', old.id, old.content, old.tool_name, old.tool_calls);
            INSERT INTO messages_fts_cjk(rowid, content, tool_name, tool_calls)
            VALUES (new.id, new.content, new.tool_name, new.tool_calls);
        END;

        -- Trigram view re-materialization is handled by triggers on messages too;
        -- the source view is read-only so we delete/insert into the trigram table.
        CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_insert AFTER INSERT ON messages
        WHEN new.role IS NULL OR new.role != 'tool' BEGIN
            INSERT INTO messages_fts_trigram(rowid, content, tool_name, tool_calls)
            VALUES (new.id, new.content, new.tool_name, new.tool_calls);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_delete AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content, tool_name, tool_calls)
            VALUES ('delete', old.id, old.content, old.tool_name, old.tool_calls);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_update
        AFTER UPDATE OF content, tool_name, tool_calls ON messages
        WHEN new.role IS NULL OR new.role != 'tool' BEGIN
            INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content, tool_name, tool_calls)
            VALUES ('delete', old.id, old.content, old.tool_name, old.tool_calls);
            INSERT INTO messages_fts_trigram(rowid, content, tool_name, tool_calls)
            VALUES (new.id, new.content, new.tool_name, new.tool_calls);
        END;
        ".trim_start(),
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn read_meta(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let mut stmt = conn
        .prepare("SELECT value FROM state_meta WHERE key = ?")
        .map_err(sqlite_err)?;
    let value: Option<String> = stmt
        .query_row(params![key], |row| row.get(0))
        .optional()
        .map_err(sqlite_err)?;
    Ok(value)
}

pub fn query(
    hermes_home: &str,
    request: StateDbQueryRequest,
) -> AppResult<Vec<HashMap<String, Value>>> {
    if request.readonly {
        let forbidden = [
            "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "REPLACE",
        ];
        let upper = request.sql.to_uppercase();
        for kw in forbidden {
            if upper.starts_with(kw) || upper.contains(&format!(" {} ", kw)) {
                return Err(AppError::InvalidRequest(format!(
                    "readonly query contains forbidden keyword: {}",
                    kw
                )));
            }
        }
    }

    let conn = connect(hermes_home)?;
    let rusqlite_params: Vec<rusqlite::types::Value> =
        request.params.iter().map(value_to_rusqlite).collect();
    let mut stmt = conn.prepare(&request.sql).map_err(sqlite_err)?;
    let column_count = stmt.column_count();
    let column_names: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(|s| s.to_string())
        .collect();

    let params = rusqlite::params_from_iter(rusqlite_params.iter());
    let rows = stmt
        .query_map(params, |row| {
            let mut map = HashMap::with_capacity(column_count);
            for (i, name) in column_names.iter().enumerate() {
                let value: rusqlite::types::Value = row.get(i)?;
                map.insert(name.clone(), sqlite_value_to_json(value));
            }
            Ok(map)
        })
        .map_err(sqlite_err)?;

    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_err)
}

pub fn exec(hermes_home: &str, request: StateDbQueryRequest) -> AppResult<i64> {
    let conn = connect(hermes_home)?;
    let rusqlite_params: Vec<rusqlite::types::Value> =
        request.params.iter().map(value_to_rusqlite).collect();
    let params = rusqlite::params_from_iter(rusqlite_params.iter());
    let affected = conn.execute(&request.sql, params).map_err(sqlite_err)?;
    Ok(affected as i64)
}

fn sqlite_value_to_json(value: rusqlite::types::Value) -> Value {
    match value {
        rusqlite::types::Value::Null => Value::Null,
        rusqlite::types::Value::Integer(i) => Value::Number(i.into()),
        rusqlite::types::Value::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        rusqlite::types::Value::Text(s) => Value::String(s),
        rusqlite::types::Value::Blob(b) => Value::String(base64::Engine::encode(
            &base64::prelude::BASE64_STANDARD,
            &b,
        )),
    }
}

pub fn fts_search(
    hermes_home: &str,
    request: StateDbFtsSearchRequest,
) -> AppResult<Vec<HashMap<String, Value>>> {
    let readonly = StateDbQueryRequest {
        sql: request.sql,
        params: request.params,
        readonly: true,
    };
    query(hermes_home, readonly)
}

pub fn search_meta(hermes_home: &str) -> AppResult<StateDbSearchMeta> {
    let conn = connect(hermes_home)?;

    let schema_version: i64 = conn
        .query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap_or(SCHEMA_VERSION);

    let fts_storage_version: i64 = read_meta(&conn, "fts_storage_version")?
        .and_then(|s| s.parse().ok())
        .unwrap_or(FTS_STORAGE_VERSION);

    let fts_rebuild_high_water: Option<i64> =
        read_meta(&conn, "fts_rebuild_high_water")?.and_then(|s| s.parse().ok());
    let fts_rebuild_progress: Option<i64> =
        read_meta(&conn, "fts_rebuild_progress")?.and_then(|s| s.parse().ok());

    let fts_stale: bool = read_meta(&conn, "fts_stale")?
        .map(|s| s == "1")
        .unwrap_or(false);
    let fts_cjk_stale: bool = read_meta(&conn, "fts_cjk_stale")?
        .map(|s| s == "1")
        .unwrap_or(false);

    let row_count_messages: i64 = conn
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .unwrap_or(0);
    let row_count_sessions: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .unwrap_or(0);

    Ok(StateDbSearchMeta {
        schema_version,
        fts_storage_version,
        fts_rebuild_high_water,
        fts_rebuild_progress,
        fts_stale,
        fts_cjk_stale,
        row_count_messages,
        row_count_sessions,
    })
}

pub fn ensure_schema(hermes_home: &str) -> AppResult<()> {
    connect(hermes_home)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn temp_conn() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("state.db");
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        init_schema(&conn).unwrap();
        (dir, conn)
    }

    #[test]
    fn schema_initializes_tables() {
        let (_dir, conn) = temp_conn();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn fts_tables_created_when_supported() {
        let (_dir, conn) = temp_conn();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages_fts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn triggers_mirror_message_changes_to_fts() {
        let (_dir, conn) = temp_conn();
        conn.execute(
            "INSERT INTO sessions(id, source, started_at) VALUES('s1', 'chat', ?)",
            params![now_ms()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages(session_id, role, content) VALUES('s1', 'user', 'hello world')",
            [],
        )
        .unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'hello'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        // Update content through the narrowing trigger.
        conn.execute(
            "UPDATE messages SET content = 'goodbye world' WHERE session_id = 's1'",
            [],
        )
        .unwrap();
        let old_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'hello'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let new_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'goodbye'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_count, 0);
        assert_eq!(new_count, 1);
    }

    #[test]
    fn query_round_trip() {
        let (dir, _conn) = temp_conn();
        let home = dir.path().to_string_lossy().to_string();

        let request = StateDbQueryRequest {
            sql: "SELECT 1 as n, 'x' as s".to_string(),
            params: vec![],
            readonly: true,
        };
        let rows = query(&home, request).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["n"], serde_json::Value::Number(1.into()));
        assert_eq!(rows[0]["s"], serde_json::Value::String("x".to_string()));
    }

    #[test]
    fn exec_insert_and_query() {
        let (dir, _conn) = temp_conn();
        let home = dir.path().to_string_lossy().to_string();

        let request = StateDbQueryRequest {
            sql: "INSERT INTO sessions(id, source, started_at) VALUES(?, ?, ?)".to_string(),
            params: vec!["s1".into(), "chat".into(), now_ms().into()],
            readonly: false,
        };
        assert!(exec(&home, request).unwrap() > 0);

        let select = StateDbQueryRequest {
            sql: "SELECT id, source FROM sessions WHERE id = ?".to_string(),
            params: vec!["s1".into()],
            readonly: true,
        };
        let rows = query(&home, select).unwrap();
        assert_eq!(
            rows[0]["source"],
            serde_json::Value::String("chat".to_string())
        );
    }

    #[test]
    fn readonly_blocks_mutations() {
        let (dir, _conn) = temp_conn();
        let home = dir.path().to_string_lossy().to_string();
        let request = StateDbQueryRequest {
            sql: "DELETE FROM sessions".to_string(),
            params: vec![],
            readonly: true,
        };
        assert!(query(&home, request).is_err());
    }

    #[test]
    fn search_meta_reports_row_counts() {
        let (dir, conn) = temp_conn();
        let home = dir.path().to_string_lossy().to_string();
        conn.execute(
            "INSERT INTO sessions(id, source, started_at) VALUES('s1', 'chat', ?)",
            params![now_ms()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages(session_id, role, content) VALUES('s1', 'user', 'hi')",
            [],
        )
        .unwrap();

        let meta = search_meta(&home).unwrap();
        assert_eq!(meta.schema_version, SCHEMA_VERSION);
        assert_eq!(meta.row_count_sessions, 1);
        assert_eq!(meta.row_count_messages, 1);
    }
}
