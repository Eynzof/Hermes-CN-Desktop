//! Serde type mirrors for the Rust skill-lint module.
//!
//! These types mirror `packages/skill-lint/src/types.ts` and are the v1
//! `LintResult` contract. `SkillFrontmatter` is deliberately lenient when
//! deserializing: known fields are extracted from string/array/object values
//! only when they have the expected shape, and stray keys fall through to the
//! `extra` map. This preserves the TypeScript `Record<string, unknown>`
//! semantics of the hand-rolled parser (e.g. `version: "1.0.0"` keeps its
//! quotes, and a non-string `name` is simply ignored by the rules).

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Severity of a lint finding. Mirrors `LintSeverity` in TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LintSeverity {
    Error,
    Warning,
}

/// A single lint finding. Mirrors `LintFinding` in TS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LintFinding {
    pub severity: LintSeverity,
    pub rule: String,
    pub message: String,
}

impl LintFinding {
    pub fn error(rule: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            severity: LintSeverity::Error,
            rule: rule.into(),
            message: message.into(),
        }
    }

    pub fn warning(rule: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            severity: LintSeverity::Warning,
            rule: rule.into(),
            message: message.into(),
        }
    }
}

/// `platforms?: string | string[]` in TS. Deserialized as an untagged enum so a
/// scalar serializes to a string and an array serializes to an array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Platforms {
    Single(String),
    List(Vec<String>),
}

/// Nested `metadata.hermes` object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HermesMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_skills: Option<Vec<String>>,
}

/// `metadata?: { hermes?: ... }` object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Metadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hermes: Option<HermesMetadata>,
}

/// Mirrors `SkillFrontmatter` in TS.
///
/// The type derives `Serialize` and has a lenient manual `Deserialize` so that
/// the hand-rolled parser can build it from a `serde_json::Value` without
/// failing on unusual value shapes.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct SkillFrontmatter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Platforms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_skills: Option<Vec<String>>,
    /// Catch-all for unknown keys (`[k: string]: unknown` in TS).
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl SkillFrontmatter {
    /// Build a `SkillFrontmatter` from a parsed `serde_json::Value`.
    ///
    /// Known fields are extracted only when the value has the expected JSON
    /// shape; otherwise they are treated as absent so the rules behave like the
    /// TS `typeof`/`Array.isArray` guards. Remaining keys land in [`Self::extra`].
    pub(crate) fn from_value(value: Value) -> Self {
        let mut obj: HashMap<String, Value> = match value {
            Value::Object(map) => map.into_iter().collect(),
            _ => return Self::default(),
        };

        let name = take_str(&mut obj, "name");
        let description = take_str(&mut obj, "description");
        let version = take_str(&mut obj, "version");
        let author = take_str(&mut obj, "author");
        let license = take_str(&mut obj, "license");
        let platforms = take_platforms(&mut obj, "platforms");
        let metadata = take_metadata(&mut obj, "metadata");
        let related_skills = take_str_list(&mut obj, "related_skills");

        Self {
            name,
            description,
            version,
            author,
            license,
            platforms,
            metadata,
            related_skills,
            extra: obj,
        }
    }

    /// Read an unknown/catch-all key from [`Self::extra`].
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.extra.get(key)
    }
}

impl<'de> Deserialize<'de> for SkillFrontmatter {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        Ok(Self::from_value(value))
    }
}

fn take_str(obj: &mut HashMap<String, Value>, key: &str) -> Option<String> {
    match obj.remove(key) {
        Some(Value::String(s)) => Some(s),
        _ => None,
    }
}

fn take_str_list(obj: &mut HashMap<String, Value>, key: &str) -> Option<Vec<String>> {
    match obj.remove(key) {
        Some(Value::Array(items)) if items.iter().all(|v| v.is_string()) => Some(
            items
                .into_iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect(),
        ),
        _ => None,
    }
}

fn take_platforms(obj: &mut HashMap<String, Value>, key: &str) -> Option<Platforms> {
    match obj.remove(key) {
        Some(Value::String(s)) => Some(Platforms::Single(s)),
        Some(Value::Array(items)) if items.iter().all(|v| v.is_string()) => Some(Platforms::List(
            items
                .into_iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect(),
        )),
        _ => None,
    }
}

fn take_metadata(obj: &mut HashMap<String, Value>, key: &str) -> Option<Metadata> {
    let value = obj.remove(key)?;
    let Value::Object(meta_map) = value else {
        return None;
    };
    let hermes = meta_map.get("hermes").and_then(|v| {
        let Value::Object(hm) = v else {
            return None;
        };
        Some(HermesMetadata {
            tags: string_list_from_map(hm, "tags"),
            related_skills: string_list_from_map(hm, "related_skills"),
        })
    });
    Some(Metadata { hermes })
}

fn string_list_from_map(map: &serde_json::Map<String, Value>, key: &str) -> Option<Vec<String>> {
    match map.get(key) {
        Some(Value::Array(items)) if items.iter().all(|v| v.is_string()) => Some(
            items
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect(),
        ),
        _ => None,
    }
}

/// `LintOptions` — mirrors `LintOptions` in TS (camelCase JSON keys).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LintOptions {
    /// Skill directory path; enables disk-based checks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_dir: Option<String>,
    /// All skill names in the scanned tree; enables `related_skills` resolution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all_names: Option<Vec<String>>,
}

/// A single skill entry in a [`LintResult`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub findings: Vec<LintFinding>,
}

/// Aggregated totals in a [`LintResult`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Totals {
    pub errors: usize,
    pub warnings: usize,
}

/// Result of a tree lint. Mirrors `LintResult` in TS (`version: 1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LintResult {
    pub version: u8,
    pub roots: Vec<String>,
    pub skills: Vec<SkillResult>,
    pub totals: Totals,
}

impl Default for LintResult {
    fn default() -> Self {
        Self {
            version: 1,
            roots: Vec::new(),
            skills: Vec::new(),
            totals: Totals::default(),
        }
    }
}
