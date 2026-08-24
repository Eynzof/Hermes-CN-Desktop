//! Gateway core: session key/store/multiplexer, durable delivery ledger, and
//! the deferred broadcast event bus. Mirrors `packages/gateway-core/src/` for
//! the packaged (Tauri) runtime; the TS in-memory implementations remain the
//! browser-only fallback.

pub mod delivery;
pub mod event;
pub mod session;

pub use delivery::{DeliveryLedger, DeliveryRow, DeliveryState, OutboundPayload};
pub use event::GatewayEvent;
pub use session::{
    build_session_key, session_id_from_key, BusyMode, ChatType, GatewaySession,
    InboundMessageEvent, MessagePart, RouteDecision, SessionMultiplexer, SessionMultiplexerOptions,
    SessionSource, SessionStore, DEFAULT_PROFILE,
};

/// Process-lifetime gateway state owned by the Rust side.
///
/// In the full plan this is stored in `AppStateInner` (`gateway: GatewayState`)
/// and injected into commands via `tauri::State`. Until that wiring lands
/// (the owning task owns `src/state.rs`), the command module keeps a process
/// global instance. Kept public so the later AppState integration can adopt it.
pub struct GatewayState {
    pub sessions: SessionStore,
    pub multiplexer: SessionMultiplexer,
}

impl Default for GatewayState {
    fn default() -> Self {
        Self::new()
    }
}

impl GatewayState {
    pub fn new() -> Self {
        Self {
            sessions: SessionStore::new(),
            multiplexer: SessionMultiplexer::new(SessionMultiplexerOptions::default()),
        }
    }
}
