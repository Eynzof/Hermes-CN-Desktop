//! Durable at-least-once delivery ledger (in-memory + SQLite-backed).
//!
//! Parity with `packages/gateway-core/src/delivery.ts`. The in-memory backend
//! mirrors the TS `DeliveryLedger` exactly; the SQLite backend persists rows to
//! `<hermes_home>/delivery.db` using the same WAL/busy_timeout conventions as
//! `src/state_db.rs`. The TS in-memory ledger remains the browser-only fallback.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const DELIVERY_DB_FILE: &str = "delivery.db";
const ATTEMPTS_MAX: i32 = 3;
const FRESHNESS_MS: i64 = 86_400_000;
/// `♻️ Recovered reply\n` (recycling symbol + variation selector + space).
const RECOVER_PREFIX: &str = "\u{267b}\u{fe0f} Recovered reply\n";

/// Delivery row state enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryState {
    Pending,
    Sending,
    Delivered,
    Failed,
}

impl DeliveryState {
    pub fn as_str(&self) -> &'static str {
        match self {
            DeliveryState::Pending => "pending",
            DeliveryState::Sending => "sending",
            DeliveryState::Delivered => "delivered",
            DeliveryState::Failed => "failed",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(DeliveryState::Pending),
            "sending" => Some(DeliveryState::Sending),
            "delivered" => Some(DeliveryState::Delivered),
            "failed" => Some(DeliveryState::Failed),
            _ => None,
        }
    }
}

/// Delivery row mirroring `deliveryRowSchema`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryRow {
    pub row_id: String,
    pub session_id: String,
    pub platform: String,
    pub chat_id: String,
    pub payload: String,
    pub state: DeliveryState,
    pub attempts: i32,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dedupe_key: Option<String>,
}

/// Outbound payload mirroring the TS `OutboundPayload`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundPayload {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explicit_media: Option<bool>,
}

struct InMemoryLedger {
    rows: HashMap<String, DeliveryRow>,
    order: Vec<String>,
}

struct SqliteDeliveryStore {
    conn: Connection,
}

enum DeliveryBackend {
    InMemory(InMemoryLedger),
    Sqlite(SqliteDeliveryStore),
}

/// At-least-once delivery ledger. Use `in_memory()` for the browser-only/dev
/// path and `sqlite(hermes_home)` for durable packaged-mode persistence.
pub struct DeliveryLedger {
    backend: DeliveryBackend,
    attempts_max: i32,
    freshness_ms: i64,
}

fn sqlite_err(e: rusqlite::Error) -> AppError {
    AppError::Internal(format!("gateway delivery sqlite error: {}", e))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn base36(mut n: u64) -> String {
    const CHARS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(CHARS[(n % 36) as usize] as char);
        n /= 36;
    }
    out.into_iter().rev().collect()
}

static ROW_SEQ: AtomicU64 = AtomicU64::new(0);

fn gen_row_id(now: i64) -> String {
    let ts36 = base36(now.max(0) as u64);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = ROW_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("dl_{}_{:x}_{:x}", ts36, nanos as u64, seq)
}

fn connect(hermes_home: &str) -> AppResult<Connection> {
    let path = Path::new(hermes_home).join(DELIVERY_DB_FILE);
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
        CREATE TABLE IF NOT EXISTS delivery_rows (
            row_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            state TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            dedupe_key TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_delivery_rows_session ON delivery_rows(session_id);
        CREATE INDEX IF NOT EXISTS idx_delivery_rows_state_created ON delivery_rows(state, created_at);
        CREATE INDEX IF NOT EXISTS idx_delivery_rows_dedupe ON delivery_rows(session_id, dedupe_key);
        "
        .trim_start(),
    )
    .map_err(sqlite_err)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn row_to_delivery(
    row_id: &str,
    session_id: &str,
    platform: &str,
    chat_id: &str,
    payload: &str,
    state: &str,
    attempts: i32,
    created_at: i64,
    dedupe_key: Option<String>,
) -> AppResult<DeliveryRow> {
    let state = DeliveryState::from_str(state)
        .ok_or_else(|| AppError::Internal(format!("unexpected delivery state in db: {}", state)))?;
    Ok(DeliveryRow {
        row_id: row_id.to_string(),
        session_id: session_id.to_string(),
        platform: platform.to_string(),
        chat_id: chat_id.to_string(),
        payload: payload.to_string(),
        state,
        attempts,
        created_at,
        dedupe_key,
    })
}

impl DeliveryLedger {
    /// In-memory ledger (used by unit tests and as the browser-only fallback).
    pub fn in_memory() -> Self {
        Self {
            backend: DeliveryBackend::InMemory(InMemoryLedger {
                rows: HashMap::new(),
                order: Vec::new(),
            }),
            attempts_max: ATTEMPTS_MAX,
            freshness_ms: FRESHNESS_MS,
        }
    }

    /// SQLite-backed ledger persisted under `<hermes_home>/delivery.db`.
    pub fn sqlite(hermes_home: &str) -> AppResult<Self> {
        let conn = connect(hermes_home)?;
        Ok(Self {
            backend: DeliveryBackend::Sqlite(SqliteDeliveryStore { conn }),
            attempts_max: ATTEMPTS_MAX,
            freshness_ms: FRESHNESS_MS,
        })
    }

    pub fn begin(
        &mut self,
        session_id: &str,
        platform: &str,
        chat_id: &str,
        payload: &OutboundPayload,
    ) -> AppResult<DeliveryRow> {
        self.begin_at(session_id, platform, chat_id, payload, now_ms())
    }

    /// Version of `begin` with an explicit timestamp (for deterministic tests).
    pub fn begin_at(
        &mut self,
        session_id: &str,
        platform: &str,
        chat_id: &str,
        payload: &OutboundPayload,
        now: i64,
    ) -> AppResult<DeliveryRow> {
        let dedupe_key = if payload.media_path.is_some() && !payload.explicit_media.unwrap_or(false)
        {
            payload.media_path.clone()
        } else {
            None
        };
        let payload_json = serde_json::to_string(payload)
            .map_err(|e| AppError::Internal(format!("serialize delivery payload: {}", e)))?;
        let row = DeliveryRow {
            row_id: gen_row_id(now),
            session_id: session_id.to_string(),
            platform: platform.to_string(),
            chat_id: chat_id.to_string(),
            payload: payload_json,
            state: DeliveryState::Pending,
            attempts: 0,
            created_at: now,
            dedupe_key,
        };

        match &mut self.backend {
            DeliveryBackend::InMemory(mem) => {
                mem.order.push(row.row_id.clone());
                mem.rows.insert(row.row_id.clone(), row.clone());
            }
            DeliveryBackend::Sqlite(store) => {
                store
                    .conn
                    .execute(
                        "INSERT INTO delivery_rows (
                            row_id, session_id, platform, chat_id, payload,
                            state, attempts, created_at, dedupe_key
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![
                            row.row_id,
                            row.session_id,
                            row.platform,
                            row.chat_id,
                            row.payload,
                            row.state.as_str(),
                            row.attempts,
                            row.created_at,
                            row.dedupe_key,
                        ],
                    )
                    .map_err(sqlite_err)?;
            }
        }
        Ok(row)
    }

    pub fn ack(&mut self, row_id: &str) -> AppResult<()> {
        match &mut self.backend {
            DeliveryBackend::InMemory(mem) => {
                if let Some(row) = mem.rows.get_mut(row_id) {
                    row.state = DeliveryState::Delivered;
                }
                Ok(())
            }
            DeliveryBackend::Sqlite(store) => {
                store
                    .conn
                    .execute(
                        "UPDATE delivery_rows SET state = ?1 WHERE row_id = ?2",
                        params![DeliveryState::Delivered.as_str(), row_id],
                    )
                    .map_err(sqlite_err)?;
                Ok(())
            }
        }
    }

    pub fn fail(&mut self, row_id: &str, error: Option<&str>) -> AppResult<()> {
        self.fail_at(row_id, error, now_ms())
    }

    /// Version of `fail` with an explicit timestamp (for deterministic tests).
    pub fn fail_at(&mut self, row_id: &str, _error: Option<&str>, now: i64) -> AppResult<()> {
        match &mut self.backend {
            DeliveryBackend::InMemory(mem) => {
                let Some(row) = mem.rows.get_mut(row_id) else {
                    return Ok(());
                };
                row.attempts += 1;
                if row.attempts >= self.attempts_max || now - row.created_at > self.freshness_ms {
                    row.state = DeliveryState::Failed;
                }
                Ok(())
            }
            DeliveryBackend::Sqlite(store) => {
                let existing = store
                    .conn
                    .query_row(
                        "SELECT attempts, created_at, state FROM delivery_rows WHERE row_id = ?1",
                        params![row_id],
                        |r| {
                            Ok((
                                r.get::<_, i32>(0)?,
                                r.get::<_, i64>(1)?,
                                r.get::<_, String>(2)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(sqlite_err)?;
                let Some((attempts, created_at, state)) = existing else {
                    return Ok(());
                };
                let new_attempts = attempts + 1;
                let stale = now - created_at > self.freshness_ms;
                let new_state = if new_attempts >= self.attempts_max || stale {
                    DeliveryState::Failed.as_str()
                } else {
                    state.as_str()
                };
                store
                    .conn
                    .execute(
                        "UPDATE delivery_rows SET attempts = ?1, state = ?2 WHERE row_id = ?3",
                        params![new_attempts, new_state, row_id],
                    )
                    .map_err(sqlite_err)?;
                Ok(())
            }
        }
    }

    /// Recover stale pending/sending rows (prefixing their text with the
    /// recycle glyph) and fail rows older than freshness / exhausted attempts.
    pub fn redeliver_on_boot(&mut self) -> AppResult<Vec<DeliveryRow>> {
        self.redeliver_on_boot_at(now_ms())
    }

    /// Version of `redeliver_on_boot` with an explicit timestamp.
    pub fn redeliver_on_boot_at(&mut self, now: i64) -> AppResult<Vec<DeliveryRow>> {
        let mut stale = Vec::new();

        match &mut self.backend {
            DeliveryBackend::InMemory(mem) => {
                for id in mem.order.clone() {
                    let Some(row) = mem.rows.get_mut(&id) else {
                        continue;
                    };
                    if !matches!(row.state, DeliveryState::Pending | DeliveryState::Sending) {
                        continue;
                    }
                    if now - row.created_at <= self.freshness_ms && row.attempts < self.attempts_max
                    {
                        if let Some(new_payload) = with_recover_prefix(&row.payload) {
                            row.payload = new_payload;
                        }
                        row.state = DeliveryState::Pending;
                        stale.push(row.clone());
                    } else {
                        row.state = DeliveryState::Failed;
                    }
                }
            }
            DeliveryBackend::Sqlite(store) => {
                let conn = &store.conn;
                let mut stmt = conn
                    .prepare(
                        "SELECT row_id, session_id, platform, chat_id, payload, state, attempts, created_at, dedupe_key
                         FROM delivery_rows
                         WHERE state IN ('pending', 'sending')
                         ORDER BY rowid ASC",
                    )
                    .map_err(sqlite_err)?;
                let rows = stmt
                    .query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                            r.get::<_, String>(5)?,
                            r.get::<_, i32>(6)?,
                            r.get::<_, i64>(7)?,
                            r.get::<_, Option<String>>(8)?,
                        ))
                    })
                    .map_err(sqlite_err)?;

                let mut recover: Vec<(String, String)> = Vec::new();
                let mut fail: Vec<String> = Vec::new();
                for row in rows {
                    let (
                        row_id,
                        session_id,
                        platform,
                        chat_id,
                        payload,
                        _state,
                        attempts,
                        created_at,
                        dedupe_key,
                    ) = row.map_err(sqlite_err)?;

                    if now - created_at <= self.freshness_ms && attempts < self.attempts_max {
                        let new_payload = with_recover_prefix(&payload).unwrap_or(payload);
                        recover.push((row_id.clone(), new_payload.clone()));
                        stale.push(row_to_delivery(
                            &row_id,
                            &session_id,
                            &platform,
                            &chat_id,
                            &new_payload,
                            DeliveryState::Pending.as_str(),
                            attempts,
                            created_at,
                            dedupe_key,
                        )?);
                    } else {
                        fail.push(row_id);
                    }
                }
                drop(stmt);

                for (row_id, payload) in &recover {
                    conn.execute(
                        "UPDATE delivery_rows SET payload = ?1, state = ?2 WHERE row_id = ?3",
                        params![payload, DeliveryState::Pending.as_str(), row_id],
                    )
                    .map_err(sqlite_err)?;
                }
                for row_id in &fail {
                    conn.execute(
                        "UPDATE delivery_rows SET state = ?1 WHERE row_id = ?2",
                        params![DeliveryState::Failed.as_str(), row_id],
                    )
                    .map_err(sqlite_err)?;
                }
            }
        }
        Ok(stale)
    }

    pub fn dedupe_media(&self, session_id: &str, path: &str, explicit: bool) -> AppResult<bool> {
        if explicit {
            return Ok(false);
        }
        match &self.backend {
            DeliveryBackend::InMemory(mem) => {
                for id in &mem.order {
                    if let Some(row) = mem.rows.get(id) {
                        if row.session_id == session_id
                            && row.dedupe_key.as_deref() == Some(path)
                            && row.state == DeliveryState::Delivered
                        {
                            return Ok(true);
                        }
                    }
                }
                Ok(false)
            }
            DeliveryBackend::Sqlite(store) => {
                let found: i64 = store
                    .conn
                    .query_row(
                        "SELECT EXISTS(
                            SELECT 1 FROM delivery_rows
                            WHERE session_id = ?1 AND dedupe_key = ?2 AND state = 'delivered'
                        )",
                        params![session_id, path],
                        |r| r.get(0),
                    )
                    .map_err(sqlite_err)?;
                Ok(found != 0)
            }
        }
    }

    pub fn list_for_session(&self, session_id: &str) -> AppResult<Vec<DeliveryRow>> {
        match &self.backend {
            DeliveryBackend::InMemory(mem) => {
                let mut out = Vec::new();
                for id in &mem.order {
                    if let Some(row) = mem.rows.get(id) {
                        if row.session_id == session_id {
                            out.push(row.clone());
                        }
                    }
                }
                Ok(out)
            }
            DeliveryBackend::Sqlite(store) => {
                let mut stmt = store
                    .conn
                    .prepare(
                        "SELECT row_id, session_id, platform, chat_id, payload, state, attempts, created_at, dedupe_key
                         FROM delivery_rows
                         WHERE session_id = ?1
                         ORDER BY rowid ASC",
                    )
                    .map_err(sqlite_err)?;
                let rows = stmt
                    .query_map(params![session_id], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                            r.get::<_, String>(5)?,
                            r.get::<_, i32>(6)?,
                            r.get::<_, i64>(7)?,
                            r.get::<_, Option<String>>(8)?,
                        ))
                    })
                    .map_err(sqlite_err)?;
                let mut out = Vec::new();
                for row in rows {
                    let (
                        row_id,
                        session_id,
                        platform,
                        chat_id,
                        payload,
                        state,
                        attempts,
                        created_at,
                        dedupe_key,
                    ) = row.map_err(sqlite_err)?;
                    out.push(row_to_delivery(
                        &row_id,
                        &session_id,
                        &platform,
                        &chat_id,
                        &payload,
                        &state,
                        attempts,
                        created_at,
                        dedupe_key,
                    )?);
                }
                Ok(out)
            }
        }
    }
}

/// Prefix the payload text with the recycle glyph unless already present.
/// Returns the new JSON payload string when a change was made.
fn with_recover_prefix(payload_json: &str) -> Option<String> {
    let mut payload: OutboundPayload =
        serde_json::from_str(payload_json).unwrap_or_else(|_| OutboundPayload {
            text: payload_json.to_string(),
            media_path: None,
            explicit_media: None,
        });
    if !payload.text.starts_with("\u{267b}\u{fe0f} ") {
        payload.text = format!("{}{}", RECOVER_PREFIX, payload.text);
        Some(serde_json::to_string(&payload).unwrap_or_else(|_| payload_json.to_string()))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    const SESSION: &str = "sess_1";
    const PLATFORM: &str = "telegram";
    const CHAT: &str = "c1";

    fn payload(text: &str) -> OutboundPayload {
        OutboundPayload {
            text: text.to_string(),
            media_path: None,
            explicit_media: None,
        }
    }

    #[test]
    fn delivery_state_accepts_all_states() {
        for s in ["pending", "sending", "delivered", "failed"] {
            assert_eq!(DeliveryState::from_str(s).unwrap().as_str(), s);
        }
        assert!(DeliveryState::from_str("queued").is_none());
    }

    #[test]
    fn delivery_row_shape_validates() {
        // Row creation round-trips through serde; a negative attempt / bad
        // state would fail at parse time (here we assert the enum mapping).
        let row = DeliveryLedger::in_memory()
            .begin_at(SESSION, PLATFORM, CHAT, &payload("hi"), 1)
            .unwrap();
        assert_eq!(row.state, DeliveryState::Pending);
        assert!(serde_json::from_value::<DeliveryRow>(serde_json::to_value(&row).unwrap()).is_ok());
        assert!(DeliveryState::from_str("nope").is_none());
    }

    #[test]
    fn begin_creates_pending_unique_row_with_json_payload() {
        let mut ledger = DeliveryLedger::in_memory();
        let row = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("hi"), 1)
            .unwrap();
        assert_eq!(row.state, DeliveryState::Pending);
        assert_eq!(row.attempts, 0);
        assert!(row.row_id.starts_with("dl_"));
        let parsed: serde_json::Value = serde_json::from_str(&row.payload).unwrap();
        assert_eq!(parsed["text"], "hi");
        assert!(row.dedupe_key.is_none());
    }

    #[test]
    fn begin_derives_dedupe_key_only_for_non_explicit_media() {
        let mut ledger = DeliveryLedger::in_memory();
        let bare = ledger
            .begin_at(
                SESSION,
                PLATFORM,
                CHAT,
                &OutboundPayload {
                    text: "pic".to_string(),
                    media_path: Some("/tmp/a.png".to_string()),
                    explicit_media: None,
                },
                1,
            )
            .unwrap();
        assert_eq!(bare.dedupe_key.as_deref(), Some("/tmp/a.png"));

        let explicit = ledger
            .begin_at(
                SESSION,
                PLATFORM,
                CHAT,
                &OutboundPayload {
                    text: "pic".to_string(),
                    media_path: Some("/tmp/b.png".to_string()),
                    explicit_media: Some(true),
                },
                1,
            )
            .unwrap();
        assert!(explicit.dedupe_key.is_none());
    }

    #[test]
    fn begin_generates_distinct_row_ids() {
        let mut ledger = DeliveryLedger::in_memory();
        let a = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("1"), 1)
            .unwrap();
        let b = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("2"), 1)
            .unwrap();
        assert_ne!(a.row_id, b.row_id);
    }

    #[test]
    fn ack_marks_row_delivered() {
        let mut ledger = DeliveryLedger::in_memory();
        let row = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("hi"), 1)
            .unwrap();
        ledger.ack(&row.row_id).unwrap();
        assert_eq!(
            ledger.list_for_session(SESSION).unwrap()[0].state,
            DeliveryState::Delivered
        );
    }

    #[test]
    fn ack_on_unknown_row_is_noop() {
        let mut ledger = DeliveryLedger::in_memory();
        ledger.ack("dl_missing").unwrap();
    }

    #[test]
    fn fail_increments_attempts_and_fails_after_max() {
        let mut ledger = DeliveryLedger::in_memory();
        let row = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("hi"), 1)
            .unwrap();
        ledger.fail_at(&row.row_id, None, 1).unwrap();
        ledger.fail_at(&row.row_id, None, 1).unwrap();
        assert_eq!(
            ledger.list_for_session(SESSION).unwrap()[0].state,
            DeliveryState::Pending
        );
        assert_eq!(ledger.list_for_session(SESSION).unwrap()[0].attempts, 2);
        ledger.fail_at(&row.row_id, None, 1).unwrap();
        assert_eq!(
            ledger.list_for_session(SESSION).unwrap()[0].state,
            DeliveryState::Failed
        );
        assert_eq!(ledger.list_for_session(SESSION).unwrap()[0].attempts, 3);
    }

    #[test]
    fn fail_on_unknown_row_is_noop() {
        let mut ledger = DeliveryLedger::in_memory();
        ledger.fail("dl_missing", None).unwrap();
    }

    #[test]
    fn redeliver_recovers_pending_rows_with_prefix() {
        let mut ledger = DeliveryLedger::in_memory();
        let pending = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("lost"), 1_000_000)
            .unwrap();
        let sending = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("mid-send"), 1_000_000)
            .unwrap();
        let done = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("done"), 1_000_000)
            .unwrap();
        ledger.ack(&done.row_id).unwrap();

        let stale = ledger.redeliver_on_boot_at(1_000_000 + 60_000).unwrap();
        let mut stale_ids: Vec<String> = stale.iter().map(|r| r.row_id.clone()).collect();
        stale_ids.sort();
        let mut expected: Vec<String> = vec![pending.row_id.clone(), sending.row_id.clone()];
        expected.sort();
        assert_eq!(stale_ids, expected);
        for row in &stale {
            assert_eq!(row.state, DeliveryState::Pending);
            let parsed: OutboundPayload = serde_json::from_str(&row.payload).unwrap();
            assert!(parsed
                .text
                .starts_with("\u{267b}\u{fe0f} Recovered reply\n"));
        }
        let rows = ledger.list_for_session(SESSION).unwrap();
        assert!(!rows
            .iter()
            .find(|r| r.state == DeliveryState::Delivered)
            .unwrap()
            .payload
            .contains("\u{267b}\u{fe0f}"));
    }

    #[test]
    fn redeliver_does_not_double_prefix() {
        let mut ledger = DeliveryLedger::in_memory();
        let row = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("lost"), 1_000_000)
            .unwrap();
        // Simulate a row already recovered by a previous boot (as TS does).
        let mut p: OutboundPayload = serde_json::from_str(&row.payload).unwrap();
        p.text = "\u{267b}\u{fe0f} Recovered reply\nlost".to_string();
        let updated = serde_json::to_string(&p).unwrap();
        if let DeliveryBackend::InMemory(mem) = &mut ledger.backend {
            mem.rows.get_mut(&row.row_id).unwrap().payload = updated;
        }

        let stale = ledger.redeliver_on_boot_at(1_000_000 + 60_000).unwrap();
        assert_eq!(stale.len(), 1);
        let recovered: OutboundPayload = serde_json::from_str(&stale[0].payload).unwrap();
        assert_eq!(recovered.text, "\u{267b}\u{fe0f} Recovered reply\nlost");
    }

    #[test]
    fn redeliver_fails_stale_rows_older_than_freshness() {
        let mut ledger = DeliveryLedger::in_memory();
        let old = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("ancient"), 1_000_000)
            .unwrap();
        let stale = ledger
            .redeliver_on_boot_at(1_000_000 + 25 * 3600_000)
            .unwrap();
        assert!(stale.is_empty());
        assert_eq!(
            ledger.list_for_session(SESSION).unwrap()[0].state,
            DeliveryState::Failed
        );
        let _ = old;
    }

    #[test]
    fn redeliver_fails_rows_that_exhausted_attempts() {
        let mut ledger = DeliveryLedger::in_memory();
        let row = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("tired"), 1_000_000)
            .unwrap();
        ledger.fail_at(&row.row_id, None, 1_000_000).unwrap();
        ledger.fail_at(&row.row_id, None, 1_000_000).unwrap();
        ledger.fail_at(&row.row_id, None, 1_000_000).unwrap();
        assert!(ledger
            .redeliver_on_boot_at(1_000_000 + 60_000)
            .unwrap()
            .is_empty());
        assert_eq!(
            ledger.list_for_session(SESSION).unwrap()[0].state,
            DeliveryState::Failed
        );
    }

    #[test]
    fn redeliver_leaves_delivered_and_failed_untouched() {
        let mut ledger = DeliveryLedger::in_memory();
        let delivered = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("ok"), 1_000_000)
            .unwrap();
        ledger.ack(&delivered.row_id).unwrap();
        let failed = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("bad"), 1_000_000)
            .unwrap();
        ledger.fail_at(&failed.row_id, None, 1_000_000).unwrap();
        ledger.fail_at(&failed.row_id, None, 1_000_000).unwrap();
        ledger.fail_at(&failed.row_id, None, 1_000_000).unwrap();

        assert!(ledger
            .redeliver_on_boot_at(1_000_000 + 60_000)
            .unwrap()
            .is_empty());
        let mut states: Vec<String> = ledger
            .list_for_session(SESSION)
            .unwrap()
            .iter()
            .map(|r| r.state.as_str().to_string())
            .collect();
        states.sort();
        assert_eq!(states, vec!["delivered", "failed"]);
    }

    #[test]
    fn dedupe_media_never_filters_explicit_media() {
        let mut ledger = DeliveryLedger::in_memory();
        let row = ledger
            .begin_at(
                SESSION,
                PLATFORM,
                CHAT,
                &OutboundPayload {
                    text: "pic".to_string(),
                    media_path: Some("/tmp/a.png".to_string()),
                    explicit_media: Some(true),
                },
                1,
            )
            .unwrap();
        ledger.ack(&row.row_id).unwrap();
        assert!(!ledger.dedupe_media(SESSION, "/tmp/a.png", true).unwrap());
    }

    #[test]
    fn dedupe_media_filters_bare_paths_already_delivered() {
        let mut ledger = DeliveryLedger::in_memory();
        let row = ledger
            .begin_at(
                SESSION,
                PLATFORM,
                CHAT,
                &OutboundPayload {
                    text: "pic".to_string(),
                    media_path: Some("/tmp/a.png".to_string()),
                    explicit_media: None,
                },
                1,
            )
            .unwrap();
        ledger.ack(&row.row_id).unwrap();
        assert!(ledger.dedupe_media(SESSION, "/tmp/a.png", false).unwrap());
    }

    #[test]
    fn dedupe_media_does_not_filter_pending_other_sessions_or_unknown_paths() {
        let mut ledger = DeliveryLedger::in_memory();
        let row = ledger
            .begin_at(
                SESSION,
                PLATFORM,
                CHAT,
                &OutboundPayload {
                    text: "pic".to_string(),
                    media_path: Some("/tmp/a.png".to_string()),
                    explicit_media: None,
                },
                1,
            )
            .unwrap();
        assert!(!ledger.dedupe_media(SESSION, "/tmp/a.png", false).unwrap());

        ledger.ack(&row.row_id).unwrap();
        assert!(!ledger
            .dedupe_media("other_sess", "/tmp/a.png", false)
            .unwrap());
        assert!(!ledger.dedupe_media(SESSION, "/tmp/b.png", false).unwrap());
    }

    #[test]
    fn dedupe_media_text_only_rows_never_match() {
        let mut ledger = DeliveryLedger::in_memory();
        let row = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("plain"), 1)
            .unwrap();
        ledger.ack(&row.row_id).unwrap();
        assert!(!ledger.dedupe_media(SESSION, "/tmp/a.png", false).unwrap());
    }

    #[test]
    fn list_for_session_returns_only_requested_in_insertion_order() {
        let mut ledger = DeliveryLedger::in_memory();
        let a = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("a"), 1)
            .unwrap();
        let b = ledger
            .begin_at("other", PLATFORM, CHAT, &payload("b"), 1)
            .unwrap();
        let c = ledger
            .begin_at(SESSION, PLATFORM, CHAT, &payload("c"), 1)
            .unwrap();
        let ids: Vec<String> = ledger
            .list_for_session(SESSION)
            .unwrap()
            .iter()
            .map(|r| r.row_id.clone())
            .collect();
        assert_eq!(ids, vec![a.row_id, c.row_id]);
        assert!(ledger.list_for_session("empty").unwrap().is_empty());
        let _ = b;
    }
}
