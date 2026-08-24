//! Deferred native broadcast event bus.
//!
//! The TypeScript `packages/gateway-core/src/event-bus.ts` is a 42-line
//! in-memory `Set<Listener>` publish loop. It is intentionally NOT ported yet:
//! a native `tokio::sync::broadcast` bus only pays off when the Rust gateway
//! service owns connections/adapters end-to-end (plan phase C / P4). With no
//! production consumer today, the TS event bus is kept as the browser-first
//! implementation and this module documents the deferred seam.
//!
//! This module only carries the wire-level `GatewayEvent` union so the IPC
//! boundary has a stable type to target once the bus is implemented.

use serde::{Deserialize, Serialize};

/// Gateway event union mirroring the TS `GatewayEvent` type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GatewayEvent {
    Inbound {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
    },
    Outbound {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
    },
    Typing {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "session.start")]
    SessionStart {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "session.end")]
    SessionEnd {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Error {
        message: String,
    },
}

// Intended future surface (not yet wired):
//
//   pub struct EventBus { tx: tokio::sync::broadcast::Sender<GatewayEvent> }
//
// Do NOT start phase C / P4 without a real consumer; keep the TS bus for now.
