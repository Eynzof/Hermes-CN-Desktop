//! Accessibility-tree snapshot formatting for browser tools.
//!
//! Python emits element refs as `@e1`, `@e2`, etc. This module normalizes raw
//! accessibility nodes into that shape, ignores non-interactive roles, and
//! handles oversized snapshots by truncating/summarizing while optionally
//! persisting the full copy to an overflow store (via a caller-provided writer).

use std::io;

use serde::{Deserialize, Serialize};

pub const SNAPSHOT_SUMMARIZE_THRESHOLD: usize = 15_000;
pub const MAX_STORED_SNAPSHOT_CHARS: usize = 1_000_000;

/// Callback that persists an overflow snapshot and returns its cache-relative path.
pub type OverflowFn<'a> = &'a dyn Fn(&str) -> io::Result<Option<String>>;

/// A node in the accessibility tree (mirrors `snapshot.ts::AccessibilityNode`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AccessibilityNode {
    pub role: Option<String>,
    pub name: Option<String>,
    pub value: Option<String>,
    #[serde(default)]
    pub children: Vec<AccessibilityNode>,
    #[serde(rename = "ref")]
    pub r#ref: Option<String>,
}

/// Result of preparing a snapshot (mirrors `snapshot.ts::FormattedSnapshot`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FormattedSnapshot {
    /// Human-readable snapshot text with `@e1` refs.
    pub text: String,
    /// Total number of interactive elements discovered.
    pub element_count: usize,
    /// True if the snapshot was truncated.
    pub truncated: bool,
    /// If truncated, the full snapshot stored for paging.
    pub overflow_path: Option<String>,
}

fn next_ref(index: usize) -> String {
    format!("@e{index}")
}

fn is_interesting_node(node: &AccessibilityNode) -> bool {
    let role = node.role.as_deref().unwrap_or("").to_ascii_lowercase();
    if role.is_empty() {
        return false;
    }
    !matches!(
        role.as_str(),
        "none" | "generic" | "presentation" | "separator" | "scrollbar"
    )
}

fn format_node(node: &AccessibilityNode, depth: usize, ref_counter: &mut usize) -> String {
    let mut lines: Vec<String> = Vec::new();
    let interesting = is_interesting_node(node);
    let indent = "  ".repeat(depth);

    let mut ref_text = String::new();
    if interesting {
        *ref_counter += 1;
        ref_text = next_ref(*ref_counter);
    }

    let role = node.role.as_deref().unwrap_or("Unknown");
    let name = node.name.as_deref().unwrap_or("").trim();
    let value = node.value.as_deref().unwrap_or("").trim();
    let label = [role, name, value]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    if interesting && !label.is_empty() {
        lines.push(format!("{indent}{ref_text} {label}"));
    }

    for child in &node.children {
        lines.push(format_node(child, depth + 1, ref_counter));
    }

    lines.join("\n")
}

/// Build a Python-compatible accessibility-tree snapshot string.
pub fn format_snapshot(root: &AccessibilityNode) -> String {
    format_node(root, 0, &mut 0).trim().to_string()
}

/// Count interactive (interesting) elements in the tree.
pub fn count_interactive_elements(root: &AccessibilityNode) -> usize {
    let interactive = if is_interesting_node(root) { 1 } else { 0 };
    interactive
        + root
            .children
            .iter()
            .map(count_interactive_elements)
            .sum::<usize>()
}

/// Format a snapshot and, if it exceeds the threshold, produce a summary while
/// optionally persisting the full copy. `overflow_writer` returns a cache-relative
/// path (e.g. `cache/web/snapshot-<id>.txt`).
pub fn prepare_snapshot(
    root: &AccessibilityNode,
    max_chars: Option<usize>,
    overflow_writer: Option<OverflowFn<'_>>,
) -> io::Result<FormattedSnapshot> {
    let full = format_snapshot(root);
    let element_count = count_interactive_elements(root);
    let max_chars = max_chars.unwrap_or(SNAPSHOT_SUMMARIZE_THRESHOLD);

    if full.len() <= max_chars {
        return Ok(FormattedSnapshot {
            text: full,
            element_count,
            truncated: false,
            overflow_path: None,
        });
    }

    // Truncate on a char boundary so non-ASCII names cannot panic.
    let truncated: String = full.chars().take(max_chars).collect();
    let summary = format!(
        "{truncated}\n\n... snapshot truncated ({} chars, {element_count} elements)",
        full.len()
    );

    let mut overflow_path = None;
    if let Some(writer) = overflow_writer {
        if full.len() <= MAX_STORED_SNAPSHOT_CHARS {
            overflow_path = writer(&full)?;
        }
    }

    Ok(FormattedSnapshot {
        text: summary,
        element_count,
        truncated: true,
        overflow_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn node(json: &str) -> AccessibilityNode {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn format_snapshot_renders_a_simple_tree_with_refs() {
        let root = node(
            r#"{
                "role": "WebArea",
                "name": "Example",
                "children": [
                    { "role": "link", "name": "Home" },
                    { "role": "button", "name": "Submit" }
                ]
            }"#,
        );
        let text = format_snapshot(&root);
        assert!(text.contains("@e1 WebArea Example"));
        assert!(text.contains("@e2 link Home"));
        assert!(text.contains("@e3 button Submit"));
    }

    #[test]
    fn format_snapshot_skips_generic_none_roles() {
        let root = node(
            r#"{
                "role": "WebArea",
                "children": [
                    { "role": "generic", "name": "ignored" },
                    { "role": "link", "name": "Click me" }
                ]
            }"#,
        );
        let text = format_snapshot(&root);
        assert!(!text.contains("generic ignored"));
        assert!(text.contains("@e2 link Click me"));
    }

    #[test]
    fn format_snapshot_indents_children() {
        let root = node(
            r#"{
                "role": "WebArea",
                "children": [
                    {
                        "role": "navigation",
                        "name": "Menu",
                        "children": [{ "role": "link", "name": "Item" }]
                    }
                ]
            }"#,
        );
        let text = format_snapshot(&root);
        assert!(text.contains("  @e2 navigation Menu"));
        assert!(text.contains("    @e3 link Item"));
    }

    #[test]
    fn prepare_snapshot_returns_full_when_under_threshold() {
        let root = node(r#"{ "role": "WebArea", "name": "Small" }"#);
        let result = prepare_snapshot(&root, None, None).unwrap();
        assert!(!result.truncated);
        assert_eq!(result.element_count, 1);
    }

    #[test]
    fn prepare_snapshot_truncates_when_over_threshold() {
        let children = (0..200)
            .map(|i| {
                serde_json::json!({ "role": "link", "name": format!("item-{i} {}", "x".repeat(200)) })
            })
            .collect::<Vec<_>>();
        let root =
            node(&serde_json::json!({ "role": "WebArea", "children": children }).to_string());
        let result = prepare_snapshot(&root, Some(200), None).unwrap();
        assert!(result.truncated);
        assert_eq!(result.element_count, 201);
        assert!(result.text.len() <= 500);
    }

    #[test]
    fn prepare_snapshot_stores_overflow_when_writer_provided() {
        let children = (0..200)
            .map(|i| {
                serde_json::json!({ "role": "link", "name": format!("item-{i} {}", "x".repeat(200)) })
            })
            .collect::<Vec<_>>();
        let root =
            node(&serde_json::json!({ "role": "WebArea", "children": children }).to_string());
        let overflow_path = "cache/web/snapshot-1.txt";
        let writer =
            |_full: &str| -> io::Result<Option<String>> { Ok(Some(overflow_path.to_string())) };
        let result = prepare_snapshot(&root, Some(200), Some(&writer)).unwrap();
        assert_eq!(result.overflow_path.as_deref(), Some(overflow_path));
    }
}
