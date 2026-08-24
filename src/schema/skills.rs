//! Serde types + deterministic SKILL.md frontmatter parsing/validation.
//!
//! Mirrors the TS `packages/agent-core/src/skills/loader.ts` `parseFrontmatter`,
//! `normalizeMetadata` and `validateSkillMetadata` (plus the `skill-lint` twin).
//! The Rust parser uses `serde_yaml` (intended contract per the rewrite plan),
//! while preserving the TS normalization/validation quirks.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub const MAX_NAME_LENGTH: usize = 64;
pub const MAX_DESCRIPTION_LENGTH: usize = 1024;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterRequest {
    pub content: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterResult {
    pub metadata: SkillMetadata,
    pub body: String,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillMetadata {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prerequisites: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// Parse a SKILL.md frontmatter block into `(normalized metadata, body)`.
pub fn parse_frontmatter(text: &str) -> (SkillMetadata, String) {
    if let Some(caps) = frontmatter_re().captures(text) {
        let raw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let body = &text[caps.get(0).unwrap().range().end..];
        let yaml: serde_yaml::Value =
            serde_yaml::from_str(raw).unwrap_or(serde_yaml::Value::Mapping(Default::default()));
        (normalize_metadata(&yaml), body.to_string())
    } else {
        (SkillMetadata::default(), text.to_string())
    }
}

/// Normalize a YAML mapping into the canonical `SkillMetadata` shape.
pub fn normalize_metadata(raw: &serde_yaml::Value) -> SkillMetadata {
    let name = yaml_scalar_string(raw, "name")
        .unwrap_or_default()
        .trim()
        .to_string();
    let description = yaml_scalar_string(raw, "description")
        .unwrap_or_default()
        .trim()
        .to_string();
    let category = yaml_scalar_string(raw, "category")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    SkillMetadata {
        name,
        description,
        category,
        platforms: yaml_string_array(raw, "platforms"),
        prerequisites: yaml_string_array(raw, "prerequisites"),
        tags: yaml_string_array(raw, "tags"),
    }
}

/// Validate + truncate skill metadata, returning warnings.
pub fn validate_skill_metadata(metadata: SkillMetadata) -> (SkillMetadata, Vec<String>) {
    let mut warnings: Vec<String> = Vec::new();
    let mut out = metadata;
    let mut name = out.name.clone();
    let mut description = out.description.clone();

    if name.is_empty() {
        warnings.push("Skill metadata is missing 'name'.".to_string());
    }
    if description.is_empty() {
        warnings.push("Skill metadata is missing 'description'.".to_string());
    }
    if name.chars().count() > MAX_NAME_LENGTH {
        warnings.push(format!(
            "Skill name exceeds {} characters and will be truncated.",
            MAX_NAME_LENGTH
        ));
        name = name.chars().take(MAX_NAME_LENGTH).collect();
    }
    if description.chars().count() > MAX_DESCRIPTION_LENGTH {
        warnings.push(format!(
            "Skill description exceeds {} characters and will be truncated.",
            MAX_DESCRIPTION_LENGTH
        ));
        description = description.chars().take(MAX_DESCRIPTION_LENGTH).collect();
    }

    out.name = name;
    out.description = description;
    (out, warnings)
}

/// Convenience for the Tauri command: parse + validate in one call.
pub fn parse_frontmatter_result(content: &str) -> FrontmatterResult {
    let (metadata, body) = parse_frontmatter(content);
    let (metadata, warnings) = validate_skill_metadata(metadata);
    FrontmatterResult {
        metadata,
        body,
        warnings,
    }
}

fn frontmatter_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^---\s*\n([\s\S]*?)\n---\s*\n?").unwrap())
}

fn yaml_scalar_string(value: &serde_yaml::Value, key: &str) -> Option<String> {
    let v = value.get(key)?;
    match v {
        serde_yaml::Value::String(s) => Some(s.clone()),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn yaml_scalar_to_string(v: &serde_yaml::Value) -> String {
    match v {
        serde_yaml::Value::String(s) => s.clone(),
        serde_yaml::Value::Number(n) => n.to_string(),
        serde_yaml::Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn yaml_string_array(value: &serde_yaml::Value, key: &str) -> Option<Vec<String>> {
    let v = value.get(key)?;
    match v {
        serde_yaml::Value::Sequence(seq) => {
            // TS: `value.map(String).filter(Boolean)` — may be an empty array.
            let arr: Vec<String> = seq
                .iter()
                .map(yaml_scalar_to_string)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            Some(arr)
        }
        serde_yaml::Value::String(s) => {
            if s.trim().is_empty() {
                None
            } else {
                Some(vec![s.trim().to_string()])
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_frontmatter_fields() {
        let text = "---\nname: sample-skill\ndescription: A sample skill\ncategory: testing\nplatforms: [linux, darwin]\ntags: [intro]\n---\n# Body\nDo the thing.\n";
        let (metadata, body) = parse_frontmatter(text);
        assert_eq!(metadata.name, "sample-skill");
        assert_eq!(metadata.description, "A sample skill");
        assert_eq!(metadata.category.as_deref(), Some("testing"));
        assert_eq!(
            metadata.platforms.as_deref(),
            Some(&vec!["linux".to_string(), "darwin".to_string()][..])
        );
        assert_eq!(
            metadata.tags.as_deref(),
            Some(&vec!["intro".to_string()][..])
        );
        assert_eq!(body.trim(), "# Body\nDo the thing.");
    }

    #[test]
    fn returns_empty_metadata_and_body_when_no_frontmatter() {
        let text = "# No frontmatter\nbody";
        let (metadata, body) = parse_frontmatter(text);
        assert_eq!(metadata.name, "");
        assert_eq!(body, text);
    }

    #[test]
    fn validates_metadata_warnings() {
        let (m, warnings) = validate_skill_metadata(SkillMetadata {
            name: String::new(),
            description: String::new(),
            ..Default::default()
        });
        assert!(warnings.contains(&"Skill metadata is missing 'name'.".to_string()));
        assert!(warnings.contains(&"Skill metadata is missing 'description'.".to_string()));
        assert_eq!(m.name, "");
    }

    #[test]
    fn truncates_overlong_name_to_64() {
        let (m, warnings) = validate_skill_metadata(SkillMetadata {
            name: "x".repeat(100),
            description: "d".to_string(),
            ..Default::default()
        });
        assert_eq!(m.name.chars().count(), 64);
        assert!(warnings.iter().any(|w| w.contains("name exceeds 64")));
    }

    #[test]
    fn truncates_overlong_description_to_1024() {
        let (m, warnings) = validate_skill_metadata(SkillMetadata {
            name: "n".to_string(),
            description: "x".repeat(2000),
            ..Default::default()
        });
        assert_eq!(m.description.chars().count(), 1024);
        assert!(warnings
            .iter()
            .any(|w| w.contains("description exceeds 1024")));
    }

    #[test]
    fn parse_frontmatter_result_composes_warnings() {
        let result = parse_frontmatter_result("# no frontmatter");
        assert_eq!(result.body, "# no frontmatter");
        assert!(result
            .warnings
            .contains(&"Skill metadata is missing 'name'.".to_string()));
    }
}
