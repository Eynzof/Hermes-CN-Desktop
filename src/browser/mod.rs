//! Browser automation Rust building blocks.
//!
//! These modules are the Rust-side mirrors of the `@hermes/browser` TS package
//! pieces that benefit from a native implementation (serde IPC mirrors, a11y
//! snapshot formatter, and the backend precedence algorithm). The TS package
//! remains the runtime authority in browser-only dev mode; in desktop mode the
//! Rust side re-validates at the IPC boundary.

pub mod registry;
pub mod snapshot;
pub mod types;

pub use registry::*;
pub use snapshot::*;
pub use types::*;
