//! The 12/13 skill-lint rules, ported 1:1 from
//! `packages/skill-lint/src/rules.ts`.
//!
//! Each rule is a pure function returning `Vec<LintFinding>`. Disk-based
//! checks (`dangling-reference`, `forbidden-file`) remain stubs here, exactly
//! as in the browser-safe TS stub; the real filesystem implementations live in
//! `tree.rs`.

use crate::skill_lint::types::{LintFinding, LintOptions, Platforms, SkillFrontmatter};
use regex::Regex;
use std::sync::OnceLock;

const NAME_RE: &str = r"^[a-z0-9_\-]+$";
const MARKETING_WORDS: &[&str] = &[
    "revolutionary",
    "cutting-edge",
    "best",
    "ultimate",
    "powerful",
    "amazing",
];
const SHELL_UTILITIES: &[&str] = &[
    "grep", "cat", "sed", "awk", "cut", "sort", "uniq", "find", "xargs", "ls", "rm", "cp", "mv",
];
const EXPECTED_SECTIONS: &[&str] = &["## When to Use"];
const POSIX_PRIMITIVES: &[&str] = &[
    "grep", "sed", "awk", "find", "xargs", "rm", "cp", "mv", "chmod", "chown",
];
const VALID_PLATFORMS: &[&str] = &["linux", "macos", "windows", "darwin"];
const SKILL_PROMPT_DESC_LIMIT: usize = 60;

fn name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(NAME_RE).unwrap())
}

fn author_caps_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[A-Z]{2,}").unwrap())
}

fn scripts_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"scripts/[a-zA-Z0-9_\-\.]+").unwrap())
}

fn fenced_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"```[\s\S]*?```").unwrap())
}

fn inline_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"`[^`]+`").unwrap())
}

fn word_re(word: &str) -> Regex {
    Regex::new(&format!(r"(?i)\b{}\b", word)).unwrap()
}

/// Remove fenced ```...``` and inline `...` code blocks (TS `stripCodeBlocks`).
fn strip_code_blocks(body: &str) -> String {
    let after_fenced = fenced_re().replace_all(body, "");
    let after_inline = inline_re().replace_all(&after_fenced, "");
    after_inline.into_owned()
}

fn field_present(value: Option<&str>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

pub fn check_name_format(name: Option<&str>) -> Vec<LintFinding> {
    let Some(name) = name else { return Vec::new() };
    if !name_re().is_match(name) {
        return vec![LintFinding::error(
            "name-format",
            format!(
                "name '{}' must be lowercase letters, numbers, '-' or '_'",
                name
            ),
        )];
    }
    Vec::new()
}

pub fn check_name_dir_mismatch(
    frontmatter: &SkillFrontmatter,
    opts: &LintOptions,
) -> Vec<LintFinding> {
    let Some(skill_dir) = opts.skill_dir.as_deref() else {
        return Vec::new();
    };
    let Some(name) = frontmatter.name.as_deref() else {
        return Vec::new();
    };
    let normalized = skill_dir.replace('\\', "/");
    let dir_name = normalized.split('/').next_back().unwrap_or("");
    if !dir_name.is_empty() && dir_name != name {
        return vec![LintFinding::error(
            "name-dir-mismatch",
            format!(
                "frontmatter name '{}' does not match directory '{}'",
                name, dir_name
            ),
        )];
    }
    Vec::new()
}

pub fn check_description_length(frontmatter: &SkillFrontmatter) -> Vec<LintFinding> {
    let Some(desc) = frontmatter.description.as_deref() else {
        return Vec::new();
    };
    if desc.chars().count() > SKILL_PROMPT_DESC_LIMIT {
        return vec![LintFinding::warning(
            "description-length",
            format!("description exceeds {} characters", SKILL_PROMPT_DESC_LIMIT),
        )];
    }
    Vec::new()
}

pub fn check_description_marketing(frontmatter: &SkillFrontmatter) -> Vec<LintFinding> {
    let Some(desc) = frontmatter.description.as_deref() else {
        return Vec::new();
    };
    let lower = desc.to_lowercase();
    let hits: Vec<&str> = MARKETING_WORDS
        .iter()
        .filter(|w| lower.contains(*w))
        .copied()
        .collect();
    if !hits.is_empty() {
        return vec![LintFinding::warning(
            "description-marketing",
            format!("description contains marketing words: {}", hits.join(", ")),
        )];
    }
    Vec::new()
}

pub fn check_missing_metadata(frontmatter: &SkillFrontmatter) -> Vec<LintFinding> {
    let mut missing = Vec::new();
    for (key, value) in [
        ("version", frontmatter.version.as_deref()),
        ("author", frontmatter.author.as_deref()),
        ("license", frontmatter.license.as_deref()),
    ] {
        if !field_present(value) {
            missing.push(key);
        }
    }
    let tags = frontmatter
        .metadata
        .as_ref()
        .and_then(|m| m.hermes.as_ref())
        .and_then(|h| h.tags.as_ref());
    let tags_missing = !matches!(tags, Some(t) if !t.is_empty());
    if tags_missing {
        missing.push("metadata.hermes.tags");
    }
    if !missing.is_empty() {
        return vec![LintFinding::warning(
            "missing-metadata",
            format!("missing fields: {}", missing.join(", ")),
        )];
    }
    Vec::new()
}

pub fn check_author_caps(frontmatter: &SkillFrontmatter) -> Vec<LintFinding> {
    let Some(author) = frontmatter.author.as_deref() else {
        return Vec::new();
    };
    if author.is_empty() {
        return Vec::new();
    }
    if author_caps_re().is_match(author) {
        return vec![LintFinding::warning(
            "author-caps",
            "author has excessive capitalization",
        )];
    }
    Vec::new()
}

pub fn check_shell_utility_reference(
    _frontmatter: &SkillFrontmatter,
    body: &str,
) -> Vec<LintFinding> {
    let prose = strip_code_blocks(body);
    let found: Vec<&str> = SHELL_UTILITIES
        .iter()
        .filter(|u| word_re(u).is_match(&prose))
        .copied()
        .collect();
    if !found.is_empty() {
        return vec![LintFinding::warning(
            "shell-utility-reference",
            format!("prose references shell utilities: {}", found.join(", ")),
        )];
    }
    Vec::new()
}

pub fn check_missing_section(_frontmatter: &SkillFrontmatter, body: &str) -> Vec<LintFinding> {
    let missing: Vec<&str> = EXPECTED_SECTIONS
        .iter()
        .filter(|s| !body.contains(**s))
        .copied()
        .collect();
    if !missing.is_empty() {
        return vec![LintFinding::warning(
            "missing-section",
            format!("missing sections: {}", missing.join(", ")),
        )];
    }
    Vec::new()
}

/// Browser-safe stub: never reads disk, always returns no findings.
pub fn check_dangling_reference(
    _frontmatter: &SkillFrontmatter,
    _body: &str,
    _opts: &LintOptions,
) -> Vec<LintFinding> {
    Vec::new()
}

pub fn check_platforms_gating(frontmatter: &SkillFrontmatter, body: &str) -> Vec<LintFinding> {
    if frontmatter.platforms.is_some() {
        return Vec::new();
    }
    if !scripts_re().is_match(body) {
        return Vec::new();
    }
    let prose = strip_code_blocks(body);
    let found: Vec<&str> = POSIX_PRIMITIVES
        .iter()
        .filter(|p| word_re(p).is_match(&prose))
        .copied()
        .collect();
    if !found.is_empty() {
        return vec![LintFinding::warning(
            "platforms-gating",
            format!(
                "POSIX primitives present but no platforms declared: {}",
                found.join(", ")
            ),
        )];
    }
    Vec::new()
}

/// Browser-safe stub: never reads disk, always returns no findings.
pub fn check_forbidden_file(
    _frontmatter: &SkillFrontmatter,
    _body: &str,
    _opts: &LintOptions,
) -> Vec<LintFinding> {
    Vec::new()
}

pub fn check_platforms_value(frontmatter: &SkillFrontmatter) -> Vec<LintFinding> {
    let Some(raw) = &frontmatter.platforms else {
        return Vec::new();
    };
    let list: Vec<&str> = match raw {
        Platforms::Single(s) => vec![s.as_str()],
        Platforms::List(items) => items.iter().map(|s| s.as_str()).collect(),
    };
    let bad: Vec<&str> = list
        .into_iter()
        .filter(|p| !VALID_PLATFORMS.contains(p))
        .collect();
    if !bad.is_empty() {
        return vec![LintFinding::warning(
            "platforms-value",
            format!("invalid platform values: {}", bad.join(", ")),
        )];
    }
    Vec::new()
}

pub fn check_related_skills(
    frontmatter: &SkillFrontmatter,
    _body: &str,
    opts: &LintOptions,
) -> Vec<LintFinding> {
    let related = frontmatter
        .metadata
        .as_ref()
        .and_then(|m| m.hermes.as_ref())
        .and_then(|h| h.related_skills.as_ref())
        .or(frontmatter.related_skills.as_ref());
    let Some(related) = related else {
        return Vec::new();
    };
    let Some(all_names) = opts.all_names.as_ref() else {
        return Vec::new();
    };
    let bad: Vec<&str> = related
        .iter()
        .map(|s| s.as_str())
        .filter(|r| !all_names.iter().any(|n| n.as_str() == *r))
        .collect();
    if !bad.is_empty() {
        return vec![LintFinding::warning(
            "related-skills",
            format!("related_skills not found: {}", bad.join(", ")),
        )];
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn opts(skill_dir: Option<&str>, all_names: Option<&[&str]>) -> LintOptions {
        LintOptions {
            skill_dir: skill_dir.map(|s| s.to_string()),
            all_names: all_names.map(|v| v.iter().map(|s| s.to_string()).collect()),
        }
    }

    // ---- checkNameFormat ----

    #[test]
    fn name_format_accepts_valid() {
        assert_eq!(check_name_format(Some("my-skill_2")), Vec::new());
        assert_eq!(check_name_format(Some("a")), Vec::new());
        assert_eq!(check_name_format(Some("123")), Vec::new());
    }

    #[test]
    fn name_format_rejects_uppercase() {
        let findings = check_name_format(Some("MySkill"));
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].severity,
            crate::skill_lint::types::LintSeverity::Error
        );
        assert_eq!(findings[0].rule, "name-format");
        assert!(findings[0].message.contains("MySkill"));
    }

    #[test]
    fn name_format_rejects_spaces_and_punctuation() {
        assert_eq!(check_name_format(Some("my skill")).len(), 1);
        assert_eq!(check_name_format(Some("my.skill")).len(), 1);
        assert_eq!(check_name_format(Some("my/skill")).len(), 1);
    }

    #[test]
    fn name_format_rejects_empty_string() {
        assert_eq!(check_name_format(Some("")).len(), 1);
    }

    #[test]
    fn name_format_ignores_non_strings() {
        assert_eq!(check_name_format(None), Vec::new());
    }

    // ---- checkNameDirMismatch ----

    #[test]
    fn name_dir_mismatch_passes_when_matches() {
        assert_eq!(
            check_name_dir_mismatch(
                &SkillFrontmatter {
                    name: Some("sample-skill".into()),
                    ..Default::default()
                },
                &opts(Some("skills/sample-skill"), None)
            ),
            Vec::new()
        );
    }

    #[test]
    fn name_dir_mismatch_errors_when_mismatch() {
        let findings = check_name_dir_mismatch(
            &SkillFrontmatter {
                name: Some("other-skill".into()),
                ..Default::default()
            },
            &opts(Some("skills/sample-skill"), None),
        );
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].severity,
            crate::skill_lint::types::LintSeverity::Error
        );
        assert_eq!(findings[0].rule, "name-dir-mismatch");
        assert!(findings[0].message.contains("other-skill"));
        assert!(findings[0].message.contains("sample-skill"));
    }

    #[test]
    fn name_dir_mismatch_normalizes_windows_separators() {
        assert_eq!(
            check_name_dir_mismatch(
                &SkillFrontmatter {
                    name: Some("sample-skill".into()),
                    ..Default::default()
                },
                &opts(Some("skills\\sample-skill"), None)
            ),
            Vec::new()
        );
        assert_eq!(
            check_name_dir_mismatch(
                &SkillFrontmatter {
                    name: Some("other".into()),
                    ..Default::default()
                },
                &opts(Some("skills\\sample-skill"), None)
            )
            .len(),
            1
        );
    }

    #[test]
    fn name_dir_mismatch_skips_without_skill_dir() {
        assert_eq!(
            check_name_dir_mismatch(
                &SkillFrontmatter {
                    name: Some("sample-skill".into()),
                    ..Default::default()
                },
                &opts(None, None)
            ),
            Vec::new()
        );
    }

    #[test]
    fn name_dir_mismatch_skips_non_string_name() {
        assert_eq!(
            check_name_dir_mismatch(&SkillFrontmatter::default(), &opts(Some("skills/42"), None)),
            Vec::new()
        );
    }

    #[test]
    fn name_dir_mismatch_trailing_slash_unverifiable() {
        assert_eq!(
            check_name_dir_mismatch(
                &SkillFrontmatter {
                    name: Some("x".into()),
                    ..Default::default()
                },
                &opts(Some("skills/sample-skill/"), None)
            ),
            Vec::new()
        );
    }

    // ---- checkDescriptionLength ----

    #[test]
    fn description_length_passes_at_limit() {
        assert_eq!(
            check_description_length(&SkillFrontmatter {
                description: Some("a".repeat(60)),
                ..Default::default()
            }),
            Vec::new()
        );
    }

    #[test]
    fn description_length_warns_over_limit() {
        let findings = check_description_length(&SkillFrontmatter {
            description: Some("a".repeat(61)),
            ..Default::default()
        });
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].severity,
            crate::skill_lint::types::LintSeverity::Warning
        );
        assert_eq!(findings[0].rule, "description-length");
        assert!(findings[0].message.contains("60"));
    }

    #[test]
    fn description_length_ignores_missing() {
        assert_eq!(
            check_description_length(&SkillFrontmatter::default()),
            Vec::new()
        );
        assert_eq!(
            check_description_length(&SkillFrontmatter {
                description: None,
                ..Default::default()
            }),
            Vec::new()
        );
    }

    // ---- checkDescriptionMarketing ----

    #[test]
    fn description_marketing_passes_plain() {
        assert_eq!(
            check_description_marketing(&SkillFrontmatter {
                description: Some("A sample skill.".into()),
                ..Default::default()
            }),
            Vec::new()
        );
    }

    #[test]
    fn description_marketing_warns_single_word_case_insensitive() {
        let findings = check_description_marketing(&SkillFrontmatter {
            description: Some("A REVOLUTIONARY skill".into()),
            ..Default::default()
        });
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].severity,
            crate::skill_lint::types::LintSeverity::Warning
        );
        assert_eq!(findings[0].rule, "description-marketing");
        assert!(findings[0].message.contains("revolutionary"));
    }

    #[test]
    fn description_marketing_lists_all_words() {
        let findings = check_description_marketing(&SkillFrontmatter {
            description: Some("The best and most powerful skill".into()),
            ..Default::default()
        });
        assert!(findings[0].message.contains("best"));
        assert!(findings[0].message.contains("powerful"));
    }

    #[test]
    fn description_marketing_ignores_missing() {
        assert_eq!(
            check_description_marketing(&SkillFrontmatter::default()),
            Vec::new()
        );
    }

    // ---- checkMissingMetadata ----

    #[test]
    fn missing_metadata_passes_when_all_present() {
        let fm = SkillFrontmatter {
            version: Some("1.0.0".into()),
            author: Some("Hermes".into()),
            license: Some("MIT".into()),
            metadata: Some(crate::skill_lint::types::Metadata {
                hermes: Some(crate::skill_lint::types::HermesMetadata {
                    tags: Some(vec!["sample".into()]),
                    ..Default::default()
                }),
            }),
            ..Default::default()
        };
        assert_eq!(check_missing_metadata(&fm), Vec::new());
    }

    #[test]
    fn missing_metadata_warns_version() {
        let fm = SkillFrontmatter {
            author: Some("Hermes".into()),
            license: Some("MIT".into()),
            metadata: Some(crate::skill_lint::types::Metadata {
                hermes: Some(crate::skill_lint::types::HermesMetadata {
                    tags: Some(vec!["x".into()]),
                    ..Default::default()
                }),
            }),
            ..Default::default()
        };
        assert!(check_missing_metadata(&fm)[0].message.contains("version"));
    }

    #[test]
    fn missing_metadata_warns_author() {
        let fm = SkillFrontmatter {
            version: Some("1.0.0".into()),
            license: Some("MIT".into()),
            metadata: Some(crate::skill_lint::types::Metadata {
                hermes: Some(crate::skill_lint::types::HermesMetadata {
                    tags: Some(vec!["x".into()]),
                    ..Default::default()
                }),
            }),
            ..Default::default()
        };
        assert!(check_missing_metadata(&fm)[0].message.contains("author"));
    }

    #[test]
    fn missing_metadata_warns_license() {
        let fm = SkillFrontmatter {
            version: Some("1.0.0".into()),
            author: Some("Hermes".into()),
            metadata: Some(crate::skill_lint::types::Metadata {
                hermes: Some(crate::skill_lint::types::HermesMetadata {
                    tags: Some(vec!["x".into()]),
                    ..Default::default()
                }),
            }),
            ..Default::default()
        };
        assert!(check_missing_metadata(&fm)[0].message.contains("license"));
    }

    #[test]
    fn missing_metadata_warns_missing_or_empty_tags() {
        let base = SkillFrontmatter {
            version: Some("1.0.0".into()),
            author: Some("Hermes".into()),
            license: Some("MIT".into()),
            ..Default::default()
        };
        assert!(check_missing_metadata(&base)[0]
            .message
            .contains("metadata.hermes.tags"));
        let empty_tags = SkillFrontmatter {
            metadata: Some(crate::skill_lint::types::Metadata {
                hermes: Some(crate::skill_lint::types::HermesMetadata {
                    tags: Some(vec![]),
                    ..Default::default()
                }),
            }),
            ..base.clone()
        };
        assert!(check_missing_metadata(&empty_tags)[0]
            .message
            .contains("metadata.hermes.tags"));
    }

    #[test]
    fn missing_metadata_aggregates_all_missing() {
        let findings = check_missing_metadata(&SkillFrontmatter::default());
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].severity,
            crate::skill_lint::types::LintSeverity::Warning
        );
        assert_eq!(findings[0].rule, "missing-metadata");
        for field in ["version", "author", "license", "metadata.hermes.tags"] {
            assert!(findings[0].message.contains(field));
        }
    }

    // ---- checkAuthorCaps ----

    #[test]
    fn author_caps_passes_normal_casing() {
        assert_eq!(
            check_author_caps(&SkillFrontmatter {
                author: Some("Hermes".into()),
                ..Default::default()
            }),
            Vec::new()
        );
        assert_eq!(
            check_author_caps(&SkillFrontmatter {
                author: Some("John Smith".into()),
                ..Default::default()
            }),
            Vec::new()
        );
    }

    #[test]
    fn author_caps_warns_on_runs() {
        assert_eq!(
            check_author_caps(&SkillFrontmatter {
                author: Some("HERMES".into()),
                ..Default::default()
            })
            .len(),
            1
        );
        assert_eq!(
            check_author_caps(&SkillFrontmatter {
                author: Some("IBM Corp".into()),
                ..Default::default()
            })
            .len(),
            1
        );
        assert_eq!(
            check_author_caps(&SkillFrontmatter {
                author: Some("Acme INC.".into()),
                ..Default::default()
            })
            .len(),
            1
        );
    }

    #[test]
    fn author_caps_ignores_empty_or_non_string() {
        assert_eq!(check_author_caps(&SkillFrontmatter::default()), Vec::new());
        assert_eq!(
            check_author_caps(&SkillFrontmatter {
                author: Some("".into()),
                ..Default::default()
            }),
            Vec::new()
        );
    }

    // ---- checkShellUtilityReference ----

    #[test]
    fn shell_utility_passes_without_utilities() {
        assert_eq!(
            check_shell_utility_reference(
                &SkillFrontmatter::default(),
                "Use this skill to summarize documents."
            ),
            Vec::new()
        );
    }

    #[test]
    fn shell_utility_warns_on_reference() {
        let findings = check_shell_utility_reference(
            &SkillFrontmatter::default(),
            "Run grep to filter the output",
        );
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].severity,
            crate::skill_lint::types::LintSeverity::Warning
        );
        assert_eq!(findings[0].rule, "shell-utility-reference");
        assert!(findings[0].message.contains("grep"));
    }

    #[test]
    fn shell_utility_matches_case_insensitively() {
        assert_eq!(
            check_shell_utility_reference(
                &SkillFrontmatter::default(),
                "Use CAT to concatenate files"
            )
            .len(),
            1
        );
        assert_eq!(
            check_shell_utility_reference(
                &SkillFrontmatter::default(),
                "Use Cat to concatenate files"
            )
            .len(),
            1
        );
        assert_eq!(
            check_shell_utility_reference(
                &SkillFrontmatter::default(),
                "use cat to concatenate files"
            )
            .len(),
            1
        );
    }

    #[test]
    fn shell_utility_lists_every_utility() {
        let findings = check_shell_utility_reference(
            &SkillFrontmatter::default(),
            "Pipe ls into grep, then use sed",
        );
        assert!(findings[0].message.contains("ls"));
        assert!(findings[0].message.contains("grep"));
        assert!(findings[0].message.contains("sed"));
    }

    #[test]
    fn shell_utility_ignores_fenced_code_blocks() {
        let body = "```bash\ngrep foo bar.txt\n```\n\nThen summarize.";
        assert_eq!(
            check_shell_utility_reference(&SkillFrontmatter::default(), body),
            Vec::new()
        );
    }

    #[test]
    fn shell_utility_ignores_inline_backticks() {
        assert_eq!(
            check_shell_utility_reference(
                &SkillFrontmatter::default(),
                "Run `grep -r` on the tree"
            ),
            Vec::new()
        );
    }

    #[test]
    fn shell_utility_does_not_match_partial_words() {
        assert_eq!(
            check_shell_utility_reference(
                &SkillFrontmatter::default(),
                "The grape harvest was great"
            ),
            Vec::new()
        );
        assert_eq!(
            check_shell_utility_reference(&SkillFrontmatter::default(), "scattered notes"),
            Vec::new()
        );
    }

    #[test]
    fn shell_utility_ignores_missing_body() {
        assert_eq!(
            check_shell_utility_reference(&SkillFrontmatter::default(), ""),
            Vec::new()
        );
    }

    // ---- checkMissingSection ----

    #[test]
    fn missing_section_passes_when_present() {
        assert_eq!(
            check_missing_section(
                &SkillFrontmatter::default(),
                "## When to Use\n\nUse it when needed."
            ),
            Vec::new()
        );
    }

    #[test]
    fn missing_section_warns_when_absent() {
        let findings =
            check_missing_section(&SkillFrontmatter::default(), "## Usage\n\nJust use it.");
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].severity,
            crate::skill_lint::types::LintSeverity::Warning
        );
        assert_eq!(findings[0].rule, "missing-section");
        assert!(findings[0].message.contains("## When to Use"));
    }

    // ---- checkDanglingReference (stub) ----

    #[test]
    fn dangling_reference_returns_no_findings_without_skill_dir() {
        assert_eq!(
            check_dangling_reference(
                &SkillFrontmatter::default(),
                "See references/guide.md",
                &opts(None, None)
            ),
            Vec::new()
        );
    }

    #[test]
    fn dangling_reference_is_stub_with_skill_dir() {
        assert_eq!(
            check_dangling_reference(
                &SkillFrontmatter::default(),
                "See references/guide.md and templates/tmpl.txt.",
                &opts(Some("skills/sample"), None)
            ),
            Vec::new()
        );
        assert_eq!(
            check_dangling_reference(
                &SkillFrontmatter::default(),
                "assets/logo.png",
                &opts(Some("skills/sample"), None)
            ),
            Vec::new()
        );
    }

    // ---- checkPlatformsGating ----

    #[test]
    fn platforms_gating_passes_when_platforms_declared() {
        let fm = SkillFrontmatter {
            platforms: Some(Platforms::List(vec!["linux".into()])),
            ..Default::default()
        };
        assert_eq!(
            check_platforms_gating(&fm, "Run scripts/setup.sh which uses grep."),
            Vec::new()
        );
    }

    #[test]
    fn platforms_gating_warns_scripts_with_posix() {
        let findings = check_platforms_gating(
            &SkillFrontmatter::default(),
            "Run scripts/setup.sh; it pipes through grep and sed.",
        );
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].severity,
            crate::skill_lint::types::LintSeverity::Warning
        );
        assert_eq!(findings[0].rule, "platforms-gating");
        assert!(findings[0].message.contains("grep"));
        assert!(findings[0].message.contains("sed"));
    }

    #[test]
    fn platforms_gating_passes_scripts_without_posix() {
        assert_eq!(
            check_platforms_gating(
                &SkillFrontmatter::default(),
                "Run scripts/setup.sh on any machine."
            ),
            Vec::new()
        );
    }

    #[test]
    fn platforms_gating_passes_posix_without_scripts() {
        assert_eq!(
            check_platforms_gating(
                &SkillFrontmatter::default(),
                "grep is mentioned in prose without scripts."
            ),
            Vec::new()
        );
    }

    #[test]
    fn platforms_gating_ignores_posix_inside_code_blocks() {
        assert_eq!(
            check_platforms_gating(
                &SkillFrontmatter::default(),
                "```sh\nfind . -name '*.py'\n```\nRun scripts/lint.sh after."
            ),
            Vec::new()
        );
    }

    // ---- checkForbiddenFile (stub) ----

    #[test]
    fn forbidden_file_is_stub() {
        assert_eq!(
            check_forbidden_file(
                &SkillFrontmatter::default(),
                "",
                &opts(Some("skills/sample"), None)
            ),
            Vec::new()
        );
        assert_eq!(
            check_forbidden_file(&SkillFrontmatter::default(), "", &opts(None, None)),
            Vec::new()
        );
    }

    // ---- checkPlatformsValue ----

    #[test]
    fn platforms_value_passes_valid() {
        assert_eq!(
            check_platforms_value(&SkillFrontmatter {
                platforms: Some(Platforms::List(vec![
                    "linux".into(),
                    "macos".into(),
                    "windows".into(),
                    "darwin".into()
                ])),
                ..Default::default()
            }),
            Vec::new()
        );
        assert_eq!(
            check_platforms_value(&SkillFrontmatter {
                platforms: Some(Platforms::Single("linux".into())),
                ..Default::default()
            }),
            Vec::new()
        );
        assert_eq!(
            check_platforms_value(&SkillFrontmatter {
                platforms: Some(Platforms::List(vec![])),
                ..Default::default()
            }),
            Vec::new()
        );
    }

    #[test]
    fn platforms_value_warns_invalid_array() {
        let findings = check_platforms_value(&SkillFrontmatter {
            platforms: Some(Platforms::List(vec!["linux".into(), "win32".into()])),
            ..Default::default()
        });
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].severity,
            crate::skill_lint::types::LintSeverity::Warning
        );
        assert_eq!(findings[0].rule, "platforms-value");
        assert!(findings[0].message.contains("win32"));
    }

    #[test]
    fn platforms_value_warns_invalid_scalar() {
        assert!(check_platforms_value(&SkillFrontmatter {
            platforms: Some(Platforms::Single("unix".into())),
            ..Default::default()
        })[0]
            .message
            .contains("unix"));
    }

    #[test]
    fn platforms_value_passes_when_missing() {
        assert_eq!(
            check_platforms_value(&SkillFrontmatter::default()),
            Vec::new()
        );
    }

    // ---- checkRelatedSkills ----

    #[test]
    fn related_skills_passes_when_resolve() {
        let fm = SkillFrontmatter {
            related_skills: Some(vec!["sample-skill".into()]),
            ..Default::default()
        };
        assert_eq!(
            check_related_skills(&fm, "", &opts(None, Some(&["sample-skill", "other-skill"]))),
            Vec::new()
        );
    }

    #[test]
    fn related_skills_warns_missing() {
        let findings = check_related_skills(
            &SkillFrontmatter {
                related_skills: Some(vec!["ghost-skill".into()]),
                ..Default::default()
            },
            "",
            &opts(None, Some(&["sample-skill", "other-skill"])),
        );
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].severity,
            crate::skill_lint::types::LintSeverity::Warning
        );
        assert_eq!(findings[0].rule, "related-skills");
        assert!(findings[0].message.contains("ghost-skill"));
    }

    #[test]
    fn related_skills_reads_from_metadata_hermes() {
        let fm = SkillFrontmatter {
            metadata: Some(crate::skill_lint::types::Metadata {
                hermes: Some(crate::skill_lint::types::HermesMetadata {
                    related_skills: Some(vec!["ghost-skill".into()]),
                    ..Default::default()
                }),
            }),
            ..Default::default()
        };
        assert!(
            check_related_skills(&fm, "", &opts(None, Some(&["sample-skill", "other-skill"])))[0]
                .message
                .contains("ghost-skill")
        );
    }

    #[test]
    fn related_skills_skips_when_no_all_names() {
        assert_eq!(
            check_related_skills(
                &SkillFrontmatter {
                    related_skills: Some(vec!["ghost-skill".into()]),
                    ..Default::default()
                },
                "",
                &opts(None, None)
            ),
            Vec::new()
        );
    }

    #[test]
    fn related_skills_ignores_missing_or_non_array() {
        assert_eq!(
            check_related_skills(
                &SkillFrontmatter::default(),
                "",
                &opts(None, Some(&["sample-skill"]))
            ),
            Vec::new()
        );
    }
}
