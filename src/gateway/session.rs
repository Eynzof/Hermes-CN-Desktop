//! Gateway session key builder / stable id / LRU+TTL store / multiplexer routing.
//!
//! Parity with `packages/gateway-core/src/session.ts` and the Python
//! `gateway/session.py` key/hash layout. The session key format is
//! `agent:<profile>:<platform>:<chatType>:<chatId>[:<userId>]` and
//! `session_id_from_key` reproduces the JS 31-multiplier rolling hash exactly
//! (`sess_` + 12 lowercase hex digits).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// Chat type allowed by `sessionSourceSchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatType {
    Dm,
    Group,
    Channel,
    Thread,
}

impl ChatType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChatType::Dm => "dm",
            ChatType::Group => "group",
            ChatType::Channel => "channel",
            ChatType::Thread => "thread",
        }
    }
}

/// Mirror of the TS `InboundMessageEvent` (adapter.ts) needed for routing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundMessageEvent {
    pub id: String,
    pub platform: String,
    pub chat_id: String,
    pub chat_type: ChatType,
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    pub parts: Vec<MessagePart>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<HashMap<String, serde_json::Value>>,
    pub received_at: i64,
}

/// Mirror of the TS `MessagePart` union (adapter.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum MessagePart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mime: Option<String>,
    },
    #[serde(rename = "voice")]
    Voice {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mime: Option<String>,
        #[serde(
            default,
            rename = "durationMs",
            skip_serializing_if = "Option::is_none"
        )]
        duration_ms: Option<f64>,
    },
}

/// Session source fields mirroring `sessionSourceSchema`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSource {
    pub platform: String,
    pub chat_id: String,
    pub chat_type: ChatType,
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

/// Mirror of the TS `GatewaySession`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySession {
    pub session_id: String,
    pub session_key: String,
    pub platform: String,
    pub chat_id: String,
    pub chat_type: ChatType,
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_override: Option<String>,
    pub created_at: i64,
    pub last_active_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_interrupted: Option<bool>,
}

/// Decision returned by `SessionMultiplexer::route`. Serialized as an
/// internally-tagged union matching the TS `RouteDecision` wire shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum RouteDecision {
    Run {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Queue {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Steer {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Interrupt {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    DropAuth {
        reason: String,
    },
    Slash {
        command: String,
        args: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

/// Re-exported alias matching the plan's public API sketch.
pub type RouteAction = RouteDecision;

pub const DEFAULT_PROFILE: &str = "main";

const MAX_SIZE: usize = 128;
const IDLE_TTL_MS: i64 = 3_600_000;

/// Build the byte-identical session key.
///
/// `agent:<profile>:<platform>:<chatType>:<chatId>[:<userId>]`. Empty `user_id`
/// is treated as absent, matching the TS `if (source.userId)` truthiness check.
pub fn build_session_key(source: &SessionSource, profile: &str) -> String {
    let base = format!(
        "agent:{}:{}:{}:{}",
        profile,
        source.platform,
        source.chat_type.as_str(),
        source.chat_id
    );
    if !source.user_id.is_empty() {
        format!("{}:{}", base, source.user_id)
    } else {
        base
    }
}

/// Deterministic 31-multiplier rolling hash formatted as `sess_` + 12 hex.
///
/// Replicates JS `Math.imul(31, h) + key.charCodeAt(i)` with `h >>> 0`,
/// iterating over UTF-16 code units so non-ASCII input is byte-identical too.
pub fn session_id_from_key(key: &str) -> String {
    let mut h: u32 = 0u32;
    for unit in key.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(u32::from(unit));
    }
    format!("sess_{:012x}", h)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// In-memory LRU + TTL session store with an O(1) key->id index.
pub struct SessionStore {
    sessions: HashMap<String, GatewaySession>,
    key_index: HashMap<String, String>,
    order: Vec<String>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            key_index: HashMap::new(),
            order: Vec::new(),
        }
    }

    pub fn get(&self, session_id: &str) -> Option<&GatewaySession> {
        self.sessions.get(session_id)
    }

    pub fn get_by_key(&self, session_key: &str) -> Option<&GatewaySession> {
        let id = self.key_index.get(session_key)?;
        self.sessions.get(id)
    }

    /// Reuse an existing session by key (updating `last_active_at`) or create a
    /// new one, evicting the least-recently-active 10% when at capacity.
    pub fn ensure(&mut self, source: &SessionSource) -> GatewaySession {
        let profile = source.profile.as_deref().unwrap_or(DEFAULT_PROFILE);
        let key = build_session_key(source, profile);
        if let Some(id) = self.key_index.get(&key).cloned() {
            if let Some(session) = self.sessions.get_mut(&id) {
                session.last_active_at = now_ms();
            }
            return self.sessions.get(&id).cloned().unwrap();
        }

        self.evict_if_needed();

        let now = now_ms();
        let session_key = key.clone();
        let session = GatewaySession {
            session_id: session_id_from_key(&session_key),
            session_key,
            platform: source.platform.clone(),
            chat_id: source.chat_id.clone(),
            chat_type: source.chat_type,
            user_id: source.user_id.clone(),
            thread_id: source.thread_id.clone(),
            scope_id: source.scope_id.clone(),
            profile: source.profile.clone(),
            title: None,
            model_override: None,
            created_at: now,
            last_active_at: now,
            restart_interrupted: None,
        };
        let id = session.session_id.clone();
        self.key_index
            .insert(session.session_key.clone(), id.clone());
        self.order.push(id.clone());
        self.sessions.insert(id, session.clone());
        session
    }

    pub fn touch(&mut self, session_id: &str) {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.last_active_at = now_ms();
        }
    }

    /// Remove sessions idle longer than the TTL. Returns the number removed.
    pub fn evict_idle_sessions(&mut self, now: i64) -> usize {
        let idle: Vec<String> = self
            .order
            .iter()
            .filter(|id| {
                self.sessions
                    .get(*id)
                    .map(|s| now - s.last_active_at > IDLE_TTL_MS)
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        let removed = idle.len();
        for id in idle {
            self.remove(&id);
        }
        removed
    }

    fn evict_if_needed(&mut self) {
        if self.sessions.len() < MAX_SIZE {
            return;
        }
        let mut candidates: Vec<(i64, usize, String)> = self
            .order
            .iter()
            .enumerate()
            .filter_map(|(idx, id)| {
                self.sessions
                    .get(id)
                    .map(|s| (s.last_active_at, idx, id.clone()))
            })
            .collect();
        // Stable sort by last-active, tie-broken by insertion order (matches the
        // TS Map insertion-order + stable Array.sort semantics).
        candidates.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let count = ((MAX_SIZE as f64) * 0.1).ceil() as usize;
        for (_, _, id) in candidates.into_iter().take(count) {
            self.remove(&id);
        }
    }

    fn remove(&mut self, id: &str) {
        if let Some(session) = self.sessions.remove(id) {
            self.key_index.remove(&session.session_key);
        }
        self.order.retain(|x| x != id);
    }
}

/// Busy-mode behavior for an already-multiplexed session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BusyMode {
    #[default]
    Queue,
    Interrupt,
    Steer,
}

/// Options for `SessionMultiplexer`. Mirrors the TS `SessionMultiplexerOptions`
/// (busyMode + admin gate). The TS `isAdmin` callback is modelled as an explicit
/// allow-list of `user_id`s to keep this serde-free and clonable.
#[derive(Debug, Clone, Default)]
pub struct SessionMultiplexerOptions {
    pub busy_mode: BusyMode,
    pub admin_user_ids: Option<HashSet<String>>,
}

/// Routes inbound events to a `RouteDecision`. Tracks busy sessions so the
/// busy-mode (`queue`/`interrupt`/`steer`) decision can be applied.
pub struct SessionMultiplexer {
    busy_sessions: HashSet<String>,
    opts: SessionMultiplexerOptions,
}

impl SessionMultiplexer {
    pub fn new(opts: SessionMultiplexerOptions) -> Self {
        Self {
            busy_sessions: HashSet::new(),
            opts,
        }
    }

    pub fn route(
        &mut self,
        event: &InboundMessageEvent,
        store: &mut SessionStore,
    ) -> RouteDecision {
        let source = SessionSource {
            platform: event.platform.clone(),
            chat_id: event.chat_id.clone(),
            chat_type: event.chat_type,
            user_id: event.user_id.clone(),
            thread_id: event.thread_id.clone(),
            scope_id: event.scope_id.clone(),
            profile: None,
        };
        let session = store.ensure(&source);

        let text = event
            .parts
            .iter()
            .find_map(|p| match p {
                MessagePart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .unwrap_or("");

        if let Some(trimmed) = text.strip_prefix('/') {
            let trimmed = trimmed.trim();
            let mut words = trimmed.split_whitespace();
            let command = words.next().unwrap_or("").to_string();
            let args = words.collect::<Vec<_>>().join(" ");
            return RouteDecision::Slash {
                command,
                args,
                session_id: session.session_id.clone(),
            };
        }

        if let Some(admins) = &self.opts.admin_user_ids {
            if !admins.contains(&event.user_id) {
                return RouteDecision::DropAuth {
                    reason: "unauthorized".to_string(),
                };
            }
        }

        if self.busy_sessions.contains(&session.session_id) {
            let sid = session.session_id.clone();
            return match self.opts.busy_mode {
                BusyMode::Interrupt => RouteDecision::Interrupt { session_id: sid },
                BusyMode::Steer => RouteDecision::Steer { session_id: sid },
                BusyMode::Queue => RouteDecision::Queue { session_id: sid },
            };
        }

        RouteDecision::Run {
            session_id: session.session_id,
        }
    }

    pub fn mark_busy(&mut self, session_id: &str, busy: bool) {
        if busy {
            self.busy_sessions.insert(session_id.to_string());
        } else {
            self.busy_sessions.remove(session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn source(chat_id: &str, user_id: &str) -> SessionSource {
        SessionSource {
            platform: "telegram".to_string(),
            chat_id: chat_id.to_string(),
            chat_type: ChatType::Dm,
            user_id: user_id.to_string(),
            thread_id: None,
            scope_id: None,
            profile: None,
        }
    }

    fn event(text: &str, user_id: &str) -> InboundMessageEvent {
        InboundMessageEvent {
            id: "e1".to_string(),
            platform: "telegram".to_string(),
            chat_id: "c1".to_string(),
            chat_type: ChatType::Dm,
            user_id: user_id.to_string(),
            username: None,
            thread_id: None,
            scope_id: None,
            parts: vec![MessagePart::Text {
                text: text.to_string(),
            }],
            raw: None,
            received_at: 0,
        }
    }

    #[test]
    fn build_session_key_without_user_id() {
        let key = build_session_key(&source("99", ""), DEFAULT_PROFILE);
        assert_eq!(key, "agent:main:telegram:dm:99");
    }

    #[test]
    fn build_session_key_appends_user_id() {
        let key = build_session_key(&source("99", "42"), DEFAULT_PROFILE);
        assert_eq!(key, "agent:main:telegram:dm:99:42");
    }

    #[test]
    fn session_id_from_key_is_stable_and_hex_shaped() {
        let id = session_id_from_key("agent:main:telegram:dm:99");
        assert!(id.starts_with("sess_"));
        assert_eq!(id.len(), 17);
        assert!(id[5..].chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(session_id_from_key("agent:main:telegram:dm:99"), id);
    }

    // Golden vectors derived from the Python/JS 31-multiplier hash. These pin
    // byte-identical parity with `sessionIdFromKey` / `gateway/session.py`.
    #[test]
    fn session_id_from_key_golden_vectors() {
        let cases = [
            ("agent:main:telegram:dm:99", "sess_00003339f7e4"),
            ("agent:main:telegram:dm:99:42", "sess_000046d72dd4"),
            ("agent:main:telegram:dm:c1:u1", "sess_000049236de4"),
            ("agent:main:telegram:group:g1", "sess_0000e4d13e72"),
            ("agent:main:telegram:dm:99:user", "sess_0000ede195a1"),
        ];
        for (key, expected) in cases {
            assert_eq!(session_id_from_key(key), expected);
        }
    }

    #[test]
    fn session_store_reuses_existing_sessions_by_key() {
        let mut store = SessionStore::new();
        let a = store.ensure(&source("c1", "u1"));
        let b = store.ensure(&source("c1", "u1"));
        assert_eq!(a.session_id, b.session_id);
        assert_eq!(store.get(&a.session_id).unwrap().session_id, b.session_id);
    }

    #[test]
    fn session_store_evicts_least_recently_active_when_over_capacity() {
        let mut store = SessionStore::new();
        let mut ids = Vec::new();
        for i in 0..140 {
            let s = source(&format!("c{}", i), &format!("u{}", i));
            let session = store.ensure(&s);
            ids.push(session.session_id);
        }
        let remaining = ids.iter().filter(|id| store.get(id).is_some()).count();
        assert_eq!(remaining, 127);
    }

    #[test]
    fn session_multiplexer_detects_slash_commands() {
        let mut store = SessionStore::new();
        let mut mux = SessionMultiplexer::new(SessionMultiplexerOptions::default());
        let decision = mux.route(&event("/status", "u1"), &mut store);
        match decision {
            RouteDecision::Slash { command, .. } => assert_eq!(command, "status"),
            other => panic!("expected slash, got {:?}", other),
        }
    }

    #[test]
    fn session_multiplexer_queues_when_busy() {
        let mut store = SessionStore::new();
        let mut mux = SessionMultiplexer::new(SessionMultiplexerOptions {
            busy_mode: BusyMode::Queue,
            ..Default::default()
        });
        let session = store.ensure(&source("c1", "u1"));
        mux.mark_busy(&session.session_id, true);
        let decision = mux.route(&event("hello", "u1"), &mut store);
        assert_eq!(
            decision,
            RouteDecision::Queue {
                session_id: session.session_id
            }
        );
    }

    #[test]
    fn session_multiplexer_drops_unauthorized_senders() {
        let mut store = SessionStore::new();
        let admins = HashSet::from(["admin".to_string()]);
        let mut mux = SessionMultiplexer::new(SessionMultiplexerOptions {
            admin_user_ids: Some(admins),
            ..Default::default()
        });
        let decision = mux.route(&event("hello", "user"), &mut store);
        assert_eq!(
            decision,
            RouteDecision::DropAuth {
                reason: "unauthorized".to_string()
            }
        );
    }

    #[test]
    fn route_decision_serializes_with_camel_case_fields() {
        let decision = RouteDecision::Slash {
            command: "status".to_string(),
            args: "".to_string(),
            session_id: "sess_00003339f7e4".to_string(),
        };
        let json = serde_json::to_value(&decision).unwrap();
        assert_eq!(json["action"], "slash");
        assert_eq!(json["command"], "status");
        assert_eq!(json["sessionId"], "sess_00003339f7e4");
    }
}
