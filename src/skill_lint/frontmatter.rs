//! Hand-rolled YAML-subset frontmatter parser, ported 1:1 from
//! `packages/skill-lint/src/frontmatter.ts`.
//!
//! This deliberately does NOT use `serde_yaml`: `serde_yaml` unquotes scalars
//! and is a full YAML parser, which would change lint messages (e.g.
//! `version: "1.0.0"` must stay `'"1.0.0"'`). The parser keeps the exact TS
//! quirks: BOM strip, `---` fences, indentation-based maps, inline `[a, b]`
//! and block `- item` lists, and quoted-scalar passthrough.

use crate::skill_lint::types::SkillFrontmatter;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

#[derive(Debug)]
pub struct LintError(pub String);

impl LintError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for LintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for LintError {}

fn frontmatter_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$").unwrap())
}

fn key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*([a-zA-Z0-9_\-]+)\s*:\s*(.*)$").unwrap())
}

/// Strip a single UTF-8 BOM (U+FEFF) if present.
fn trim_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

/// Port of `parseInlineList` in frontmatter.ts.
fn parse_inline_list(value: &str) -> Value {
    let inner = value[1..value.len() - 1].trim();
    if inner.is_empty() {
        return Value::Array(Vec::new());
    }
    let items: Vec<String> = inner
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    Value::Array(items.into_iter().map(Value::String).collect())
}

/// Stateful port of the nested `parseBlock`/`parseYamlLike` logic.
struct YamlParser<'a> {
    lines: &'a [&'a str],
    i: usize,
}

impl<'a> YamlParser<'a> {
    fn indent_of(line: &str) -> isize {
        line.chars().take_while(|&c| c == ' ').count() as isize
    }

    fn parse_block(&mut self, base_indent: isize) -> Map<String, Value> {
        let mut obj = Map::new();
        while self.i < self.lines.len() {
            let raw = self.lines[self.i];
            if raw.trim().is_empty() {
                self.i += 1;
                continue;
            }
            let ind = Self::indent_of(raw);
            if ind <= base_indent {
                break;
            }
            let caps = match key_re().captures(raw) {
                Some(c) => c,
                None => {
                    self.i += 1;
                    continue;
                }
            };
            let key = caps.get(1).unwrap().as_str().to_string();
            let rest = caps.get(2).unwrap().as_str().trim().to_string();
            self.i += 1;

            if rest.is_empty() {
                // Determine if the following lines form a list or a nested map.
                if self.i < self.lines.len() {
                    let next_ind = Self::indent_of(self.lines[self.i]);
                    if next_ind > ind {
                        let first = self.lines[self.i].trim();
                        if first.starts_with("- ") {
                            let mut arr: Vec<String> = Vec::new();
                            while self.i < self.lines.len() {
                                let line = self.lines[self.i];
                                if line.trim().is_empty() {
                                    self.i += 1;
                                    continue;
                                }
                                if Self::indent_of(line) <= ind {
                                    break;
                                }
                                let t = line.trim();
                                if let Some(rest) = t.strip_prefix("- ") {
                                    arr.push(rest.trim().to_string());
                                    self.i += 1;
                                } else {
                                    self.i += 1;
                                }
                            }
                            obj.insert(
                                key,
                                Value::Array(arr.into_iter().map(Value::String).collect()),
                            );
                            continue;
                        }
                    }
                }
                let child = self.parse_block(ind);
                if !child.is_empty() {
                    obj.insert(key, Value::Object(child));
                }
            } else if rest.starts_with('[') && rest.ends_with(']') {
                obj.insert(key, parse_inline_list(&rest));
            } else {
                obj.insert(key, Value::String(rest));
            }
        }
        obj
    }
}

/// Port of `parseYamlLike` in frontmatter.ts.
fn parse_yaml_like(text: &str) -> Value {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut parser = YamlParser {
        lines: &lines,
        i: 0,
    };
    Value::Object(parser.parse_block(-1))
}

/// Port of `parseFrontmatter` in frontmatter.ts.
///
/// Returns `(frontmatter, body)`. Throws a [`LintError`] carrying the TS
/// `"missing frontmatter"` message when no valid `---` fence pair exists.
pub fn parse_frontmatter(content: &str) -> Result<(SkillFrontmatter, String), LintError> {
    let text = trim_bom(content);
    let caps = frontmatter_re()
        .captures(text)
        .ok_or_else(|| LintError::new("missing frontmatter"))?;
    let raw = parse_yaml_like(caps.get(1).unwrap().as_str());
    let frontmatter = SkillFrontmatter::from_value(raw);
    let body = caps.get(2).map_or("", |m| m.as_str()).to_string();
    Ok((frontmatter, body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn parse(content: &str) -> SkillFrontmatter {
        parse_frontmatter(content).unwrap().0
    }

    fn body(content: &str) -> String {
        parse_frontmatter(content).unwrap().1
    }

    #[test]
    fn parses_complete_skill_document() {
        let content = "---\nname: sample-skill\ndescription: A sample skill.\nversion: \"1.0.0\"\nauthor: Hermes\nlicense: MIT\nplatforms: [linux, macos, windows]\n---\n\n## When to Use\n\nUse this skill when needed.\n";
        let (fm, b) = parse_frontmatter(content).unwrap();
        assert_eq!(fm.name.as_deref(), Some("sample-skill"));
        assert_eq!(fm.description.as_deref(), Some("A sample skill."));
        assert_eq!(fm.author.as_deref(), Some("Hermes"));
        assert_eq!(fm.license.as_deref(), Some("MIT"));
        assert_eq!(
            fm.platforms,
            Some(crate::skill_lint::types::Platforms::List(vec![
                "linux".to_string(),
                "macos".to_string(),
                "windows".to_string()
            ]))
        );
        assert_eq!(b, "\n## When to Use\n\nUse this skill when needed.\n");
    }

    #[test]
    fn parses_inline_list_into_trimmed_array() {
        let fm = parse("---\ntags: [alpha, beta,  gamma]\n---\nbody\n");
        assert_eq!(
            fm.extra.get("tags"),
            Some(&Value::Array(vec![
                Value::String("alpha".into()),
                Value::String("beta".into()),
                Value::String("gamma".into())
            ]))
        );
    }

    #[test]
    fn parses_empty_inline_list_into_empty_array() {
        let fm = parse("---\ntags: []\n---\nbody\n");
        assert_eq!(fm.extra.get("tags"), Some(&Value::Array(vec![])));
    }

    #[test]
    fn parses_nested_maps_metadata_hermes_tags() {
        let fm = parse("---\nname: nested-skill\nmetadata:\n  hermes:\n    tags: [sample, nested]\n---\nbody\n");
        assert_eq!(fm.name.as_deref(), Some("nested-skill"));
        let metadata = fm.metadata.as_ref().expect("metadata present");
        let hermes = metadata.hermes.as_ref().expect("hermes present");
        assert_eq!(
            hermes.tags,
            Some(vec!["sample".to_string(), "nested".to_string()])
        );
    }

    #[test]
    fn parses_block_list_under_empty_key() {
        let fm = parse("---\nrelated_skills:\n  - skill-one\n  - skill-two\n---\nbody\n");
        assert_eq!(
            fm.related_skills,
            Some(vec!["skill-one".to_string(), "skill-two".to_string()])
        );
    }

    #[test]
    fn parses_block_list_nested_inside_map() {
        let fm =
            parse("---\nmetadata:\n  hermes:\n    tags:\n      - one\n      - two\n---\nbody\n");
        let hermes = fm.metadata.as_ref().unwrap().hermes.as_ref().unwrap();
        assert_eq!(
            hermes.tags,
            Some(vec!["one".to_string(), "two".to_string()])
        );
    }

    #[test]
    fn keeps_quoted_scalar_values_as_is() {
        let fm =
            parse("---\nversion: \"1.2.3\"\ndescription: 'A quoted description.'\n---\nbody\n");
        assert_eq!(fm.version.as_deref(), Some("\"1.2.3\""));
        assert_eq!(fm.description.as_deref(), Some("'A quoted description.'"));
    }

    #[test]
    fn preserves_colons_inside_values() {
        let fm = parse("---\nname: tool\nurl: https://example.com/a:b\n---\nbody\n");
        assert_eq!(fm.name.as_deref(), Some("tool"));
        assert_eq!(
            fm.extra.get("url"),
            Some(&Value::String("https://example.com/a:b".into()))
        );
    }

    #[test]
    fn skips_comment_and_non_key_value_lines() {
        let fm = parse("---\n# leading comment\nname: ok-skill\n\nsome prose line without a colon\nlicense: MIT\n---\nbody\n");
        assert_eq!(fm.name.as_deref(), Some("ok-skill"));
        assert_eq!(fm.license.as_deref(), Some("MIT"));
        assert!(fm.extra.get("some prose line without a colon").is_none());
    }

    #[test]
    fn handles_empty_frontmatter_block() {
        let (fm, b) = parse_frontmatter("---\n\n---\nbody\n").unwrap();
        assert_eq!(fm, SkillFrontmatter::default());
        assert_eq!(b, "body\n");
    }

    #[test]
    fn does_not_parse_dash_dash_dash_newline_dash_dash_dash() {
        assert!(parse_frontmatter("---\n---\nbody\n").is_err());
    }

    #[test]
    fn handles_crlf_line_endings() {
        let (fm, b) = parse_frontmatter(
            "---\r\nname: crlf-skill\r\ndescription: CRLF doc.\r\n---\r\nbody text\r\n",
        )
        .unwrap();
        assert_eq!(fm.name.as_deref(), Some("crlf-skill"));
        assert_eq!(b, "body text\r\n");
    }

    #[test]
    fn strips_utf8_bom() {
        let fm = parse("\u{feff}---\nname: bom-skill\n---\nbody\n");
        assert_eq!(fm.name.as_deref(), Some("bom-skill"));
    }

    #[test]
    fn keeps_fence_separators_inside_body() {
        let b = body("---\nname: with-separator\n---\nBefore\n\n---\n\nAfter\n");
        assert_eq!(b, "Before\n\n---\n\nAfter\n");
    }

    #[test]
    fn returns_empty_body_when_closing_fence_is_end() {
        let (fm, b) = parse_frontmatter("---\nname: no-body\n---").unwrap();
        assert_eq!(fm.name.as_deref(), Some("no-body"));
        assert_eq!(b, "");
    }

    #[test]
    fn throws_missing_frontmatter_for_plain_text() {
        let err = parse_frontmatter("just plain text").unwrap_err();
        assert_eq!(err.to_string(), "missing frontmatter");
    }

    #[test]
    fn throws_missing_frontmatter_when_closing_fence_missing() {
        assert!(parse_frontmatter("---\nname: unclosed").is_err());
    }

    #[test]
    fn throws_missing_frontmatter_when_content_does_not_start_with_fence() {
        assert!(parse_frontmatter("\n---\nname: indented\n---\nbody\n").is_err());
    }

    #[test]
    fn throws_missing_frontmatter_for_empty_content() {
        assert!(parse_frontmatter("").is_err());
    }

    #[test]
    fn parses_keys_with_underscores_digits_dashes() {
        let fm = parse("---\nmy-key_1: value-1\n---\nbody\n");
        assert_eq!(
            fm.extra.get("my-key_1"),
            Some(&Value::String("value-1".into()))
        );
    }
}
