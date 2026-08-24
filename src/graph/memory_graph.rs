//! Pure in-memory memory-graph builder.
//!
//! Mirrors `packages/agent-core/src/learning/graph.ts` `buildMemoryGraph`.
//! Node ids are `memory:{scope}:{i}` / `session:{id}`; edges are capped at
//! `maxEdgesPerNode` per source and rounded to 4 decimals (`score.toFixed(4)`).
//! Session-store failures from the TS side are handled by the caller (it passes
//! an empty session list), so this function never throws.

use crate::schema::graph::{
    MemoryGraph, MemoryGraphEdge, MemoryGraphNode, MemoryGraphRequest, MemoryGraphStats,
};
use std::cmp::Ordering;
use std::collections::HashSet;

pub fn build_memory_graph(request: &MemoryGraphRequest) -> MemoryGraph {
    let max_edges = request.max_edges_per_node.unwrap_or(4);
    let min_score = request.min_edge_score.unwrap_or(0.0);

    let mut nodes: Vec<MemoryGraphNode> = Vec::new();
    let mut edges: Vec<MemoryGraphEdge> = Vec::new();

    let mut memory_nodes: Vec<MemoryGraphNode> = Vec::new();
    let mut memory_tokens: Vec<Vec<String>> = Vec::new();

    for scope in ["memory", "user"] {
        let scope_entries: Vec<&crate::schema::graph::MemoryEntry> = request
            .memory_entries
            .iter()
            .filter(|e| e.scope == scope)
            .collect();
        for (i, entry) in scope_entries.iter().enumerate() {
            let id = format!("memory:{}:{}", scope, i);
            let label = entry
                .content
                .chars()
                .take(60)
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let label = if label.trim().is_empty() {
                id.clone()
            } else {
                label.trim().to_string()
            };
            let metadata = serde_json::json!({
                "importance": entry.importance,
                "fullLength": entry.content.encode_utf16().count(),
            });
            memory_nodes.push(MemoryGraphNode {
                id: id.clone(),
                kind: "memory".to_string(),
                label,
                timestamp: None,
                source: Some(scope.to_string()),
                metadata: Some(metadata),
            });
            memory_tokens.push(tokenize(&entry.content));
        }
    }
    nodes.extend(memory_nodes.iter().cloned());

    for session in &request.sessions {
        nodes.push(MemoryGraphNode {
            id: format!("session:{}", session.id),
            kind: "session".to_string(),
            label: session.title.clone(),
            timestamp: Some(session.started_at),
            source: Some(
                session
                    .source
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string()),
            ),
            metadata: Some(serde_json::json!({
                "messageCount": session.message_count,
                "toolCallCount": session.tool_call_count,
            })),
        });
    }

    // Keyword edges among memory nodes.
    for i in 0..memory_nodes.len() {
        let source_node = &memory_nodes[i];
        let mut candidates: Vec<ScoredEdge> = Vec::new();
        for j in 0..memory_nodes.len() {
            if i == j {
                continue;
            }
            let target_node = &memory_nodes[j];
            let score = shared_keyword_score(&memory_tokens[i], &memory_tokens[j]);
            if score >= min_score {
                candidates.push(ScoredEdge {
                    target: target_node.id.clone(),
                    score,
                });
            }
        }
        edges.extend(top_edges(&source_node.id, candidates, "keyword", max_edges));
    }

    // Session -> memory edges by keyword overlap.
    for session in &request.sessions {
        let session_id = format!("session:{}", session.id);
        let session_text = format!(
            "{} {}",
            session.title,
            session.preview.as_deref().unwrap_or("")
        );
        let session_tokens = tokenize(&session_text);
        let mut candidates: Vec<ScoredEdge> = Vec::new();
        for i in 0..memory_nodes.len() {
            let memory_node = &memory_nodes[i];
            let score = shared_keyword_score(&session_tokens, &memory_tokens[i]);
            if score >= min_score {
                candidates.push(ScoredEdge {
                    target: memory_node.id.clone(),
                    score,
                });
            }
        }
        edges.extend(top_edges(&session_id, candidates, "related", max_edges));
    }

    let stats = MemoryGraphStats {
        node_count: nodes.len(),
        edge_count: edges.len(),
        topic_count: 0,
        memory_count: memory_nodes.len(),
        session_count: request.sessions.len(),
    };

    MemoryGraph {
        nodes,
        edges,
        stats,
    }
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || is_cjk(c) {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .filter(|t| t.chars().count() > 2)
        .map(|s| s.to_string())
        .collect()
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x4E00..=0x9FFF)
}

fn shared_keyword_score(a: &[String], b: &[String]) -> f64 {
    let set_b: HashSet<&String> = b.iter().collect();
    let shared = a.iter().filter(|t| set_b.contains(*t)).count();
    let total: HashSet<&String> = a.iter().chain(b.iter()).collect();
    if total.is_empty() {
        0.0
    } else {
        shared as f64 / total.len() as f64
    }
}

#[derive(Debug)]
struct ScoredEdge {
    target: String,
    score: f64,
}

fn top_edges(
    source_id: &str,
    candidates: Vec<ScoredEdge>,
    kind: &str,
    max_edges: usize,
) -> Vec<MemoryGraphEdge> {
    let mut sorted: Vec<ScoredEdge> = candidates.into_iter().filter(|c| c.score > 0.0).collect();
    // Matches the JS stable `.sort((a,b) => b.score - a.score)` (ties preserve input order).
    sorted.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
    sorted.truncate(max_edges);
    sorted
        .into_iter()
        .map(|c| MemoryGraphEdge {
            source: source_id.to_string(),
            target: c.target,
            kind: kind.to_string(),
            weight: (c.score * 10_000.0).round() / 10_000.0,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::graph::{MemoryEntry, SessionEntry};

    fn req(memory_entries: Vec<MemoryEntry>, sessions: Vec<SessionEntry>) -> MemoryGraphRequest {
        MemoryGraphRequest {
            memory_entries,
            sessions,
            max_edges_per_node: Some(4),
            min_edge_score: None,
        }
    }

    #[test]
    fn empty_graph_for_empty_stores() {
        let graph = build_memory_graph(&req(vec![], vec![]));
        assert!(graph.nodes.is_empty());
        assert!(graph.edges.is_empty());
        assert_eq!(
            graph.stats,
            MemoryGraphStats {
                node_count: 0,
                edge_count: 0,
                topic_count: 0,
                memory_count: 0,
                session_count: 0,
            }
        );
    }

    #[test]
    fn creates_nodes_for_memory_entries() {
        let entries = vec![
            MemoryEntry {
                id: "".into(),
                content: "hello world example".into(),
                importance: 0.5,
                scope: "memory".into(),
            },
            MemoryEntry {
                id: "".into(),
                content: "foo bar example".into(),
                importance: 0.5,
                scope: "memory".into(),
            },
        ];
        let graph = build_memory_graph(&req(entries, vec![]));
        assert_eq!(graph.stats.memory_count, 2);
        assert_eq!(
            graph
                .nodes
                .iter()
                .map(|n| n.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["memory", "memory"]
        );
    }

    #[test]
    fn creates_nodes_for_sessions() {
        let sessions = vec![SessionEntry {
            id: "s1".into(),
            title: "test session".into(),
            preview: None,
            source: Some("cli".into()),
            started_at: 123,
            message_count: 2,
            tool_call_count: 0,
        }];
        let graph = build_memory_graph(&req(vec![], sessions));
        assert_eq!(graph.stats.session_count, 1);
        assert_eq!(graph.nodes[0].kind, "session");
        assert_eq!(graph.nodes[0].label, "test session");
    }

    #[test]
    fn links_memory_nodes_by_shared_keywords() {
        let entries = vec![
            MemoryEntry {
                id: "".into(),
                content: "javascript testing library".into(),
                importance: 0.5,
                scope: "memory".into(),
            },
            MemoryEntry {
                id: "".into(),
                content: "python testing framework".into(),
                importance: 0.5,
                scope: "memory".into(),
            },
        ];
        let graph = build_memory_graph(&req(entries, vec![]));
        assert!(graph.edges.len() > 0);
        assert!(graph.edges.iter().all(|e| e.kind == "keyword"));
        assert!(graph.edges[0].weight > 0.0);
    }

    #[test]
    fn links_sessions_to_related_memory_nodes() {
        let entries = vec![MemoryEntry {
            id: "".into(),
            content: "deployment pipeline for kubernetes".into(),
            importance: 0.5,
            scope: "memory".into(),
        }];
        let sessions = vec![SessionEntry {
            id: "s1".into(),
            title: "kubernetes deployment".into(),
            preview: None,
            source: None,
            started_at: 123,
            message_count: 1,
            tool_call_count: 0,
        }];
        let graph = build_memory_graph(&req(entries, sessions));
        let related = graph.edges.iter().filter(|e| e.kind == "related").count();
        assert!(related > 0);
    }

    #[test]
    fn respects_max_edges_per_node() {
        let entries = vec![
            MemoryEntry {
                id: "".into(),
                content: "one two three".into(),
                importance: 0.5,
                scope: "memory".into(),
            },
            MemoryEntry {
                id: "".into(),
                content: "one two three".into(),
                importance: 0.5,
                scope: "memory".into(),
            },
            MemoryEntry {
                id: "".into(),
                content: "one two three".into(),
                importance: 0.5,
                scope: "memory".into(),
            },
        ];
        let mut r = req(entries, vec![]);
        r.max_edges_per_node = Some(1);
        let graph = build_memory_graph(&r);
        let mut outgoing: std::collections::HashMap<String, usize> = Default::default();
        for e in &graph.edges {
            *outgoing.entry(e.source.clone()).or_insert(0) += 1;
        }
        for count in outgoing.values() {
            assert!(*count <= 1);
        }
    }

    #[test]
    fn ids_follow_memory_scope_pattern() {
        let entries = vec![
            MemoryEntry {
                id: "".into(),
                content: "abc def".into(),
                importance: 0.5,
                scope: "memory".into(),
            },
            MemoryEntry {
                id: "".into(),
                content: "ghi jkl".into(),
                importance: 0.5,
                scope: "user".into(),
            },
        ];
        let graph = build_memory_graph(&req(entries, vec![]));
        assert!(graph.nodes.iter().any(|n| n.id == "memory:memory:0"));
        assert!(graph.nodes.iter().any(|n| n.id == "memory:user:0"));
    }
}
