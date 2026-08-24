//! Learning / memory graph builder.
//!
//! Home for the deterministic `build_memory_graph` algorithm used by the
//! `agent_core_memory_graph_build` Tauri command.

pub mod memory_graph;

pub use memory_graph::build_memory_graph;
