//! Serde types for the memory-graph builder IPC boundary.
//!
//! Mirrors `packages/agent-core/src/learning/graph.ts` + `learning/types.ts`
//! (MemoryGraph, MemoryGraphNode, MemoryGraphEdge, MemoryGraph stats).

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphRequest {
    #[serde(default)]
    pub memory_entries: Vec<MemoryEntry>,
    #[serde(default)]
    pub sessions: Vec<SessionEntry>,
    #[serde(default)]
    pub max_edges_per_node: Option<usize>,
    #[serde(default)]
    pub min_edge_score: Option<f64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    #[serde(default)]
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub importance: f64,
    #[serde(default)]
    pub scope: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    pub started_at: i64,
    pub message_count: usize,
    pub tool_call_count: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraph {
    pub nodes: Vec<MemoryGraphNode>,
    pub edges: Vec<MemoryGraphEdge>,
    pub stats: MemoryGraphStats,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub weight: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphStats {
    pub node_count: usize,
    pub edge_count: usize,
    pub topic_count: usize,
    pub memory_count: usize,
    pub session_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trips() {
        let req: MemoryGraphRequest = serde_json::from_value(serde_json::json!({
            "memoryEntries": [{ "content": "hello", "scope": "memory" }],
            "sessions": []
        }))
        .unwrap();
        assert_eq!(req.memory_entries.len(), 1);
        assert_eq!(req.memory_entries[0].scope, "memory");
        assert!(req.max_edges_per_node.is_none());
    }
}
