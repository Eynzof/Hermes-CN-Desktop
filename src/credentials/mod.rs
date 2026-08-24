//! Credential pool: pure rotation strategies, the in-memory pool core, and an
//! in-memory secret vault (Phase 2 skeleton).
//!
//! This module mirrors the TypeScript `packages/credential-pool/src/` package.
//! The TS package remains the authoritative runtime for browser-only dev; this
//! Rust module is the canonical home for future Rust-side consumers.

pub mod constants;
pub mod pool;
pub mod strategies;
pub mod types;
pub mod vault;

pub use constants::*;
pub use pool::CredentialPool;
pub use strategies::select_credential;
pub use types::*;
pub use vault::{CredentialVault, VaultEntry, VaultEntryMetadata};
