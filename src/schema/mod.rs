//! Shared serde schema home.
//!
//! Pure `serde`/`serde_json` types that mirror the `@hermes/protocol` Zod
//! schemas and the TS wire shapes used at the Rust IPC/HTTP/WS boundaries.
//! Convention: every struct derives `Serialize, Deserialize, Debug, Clone`
//! (`+ PartialEq` where needed), uses `#[serde(rename_all = "camelCase")]`,
//! and keeps `Option<T>` (+ `#[serde(default)]`) for null/missing-tolerant fields
//! to match Zod `.nullish()/.optional()/.default()/.passthrough()` semantics.
//! Do **not** add `deny_unknown_fields`.

pub mod acp;
pub mod api_server;
pub mod compaction;
pub mod cron;
pub mod egress;
pub mod gateway;
pub mod graph;
pub mod lsp;
pub mod mcp;
pub mod message;
pub mod observability;
pub mod session;
pub mod session_log;
pub mod skills;
pub mod state_db;
pub mod subscription;
pub mod tokenize;
pub mod tool;
pub mod util;
pub mod wake;

// Re-export the primary boundary types so `crate::schema::*` can be used as a
// single source of truth without repeating the submodule path.
pub use acp::{AcpInitializeParams, AcpSessionRow, AcpSessionState, AcpStatus};
pub use api_server::{
    ApiServerStatus, ChatCompletionChunk, ChatCompletionChunkChoice, ChatCompletionDelta,
    ChatCompletionMessage, ChatCompletionRequest, ChatCompletionResponse,
};
pub use egress::{EgressAction, EgressProxyRule, EgressProxyStatus, SecretBundle, SecretImport};
pub use gateway::{parse_gateway_event, GatewayEvent, GatewayKnownEvent, RawGatewayEvent};
pub use lsp::{LspConfig, LspProcessStatus, LspServerStatus, LspSpawnArgs};
pub use mcp::{McpServerConfig, McpServerEntry, McpServerStatus, McpStdioSpawnArgs};
pub use observability::{OtelEvent, OtelSpan, TelemetryConfig};
pub use session::{MessagesResponse, SessionMessage};
pub use session_log::session_log_to_messages;
pub use state_db::{StateDbFtsSearchRequest, StateDbQueryRequest, StateDbSearchMeta};
pub use subscription::{ProxyProvider, ProxyStatus, UpstreamCredential};
pub use util::{
    default_empty_object, default_false, default_readonly, default_true, nullish_string,
};
pub use wake::{WakeFeedInput, WakeFrameInfoResult, WakeStartInput, WakeStopInput};
