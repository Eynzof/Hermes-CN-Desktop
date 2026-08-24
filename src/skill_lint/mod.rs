//! Rust skills-lint module.
//!
//! A pure, dependency-light reimplementation of `packages/skill-lint`.
//! The TS implementation remains the browser-only fallback / parity oracle.
//!
//! Design decisions:
//! - The frontmatter parser is a hand-rolled YAML-subset port (NOT `serde_yaml`)
//!   so output is byte-identical to the TS `parseFrontmatter` (scalar quotes,
//!   indentation maps, inline/block lists, BOM/CRLF handling).
//! - `lint_skill_content` mirrors `lintSkillContent` exactly (including the
//!   browser-safe stubs for `dangling-reference` and `forbidden-file`).
//! - `lint_tree` is the REAL filesystem walker (TS `lintTree` is a browser stub);
//!   it discovers `SKILL.md` files recursively and adds the disk-based checks
//!   (`name-dir-mismatch` from the real dir basename, `forbidden-file`,
//!   `dangling-reference`) on top of the content checks.

pub mod cli;
pub mod frontmatter;
pub mod rules;
pub mod tree;
pub mod types;

pub use frontmatter::{parse_frontmatter, LintError};
pub use rules::*;
pub use tree::lint_tree;
pub use types::*;

/// Lint a single SKILL.md content string. Returns findings (never throws).
pub fn lint_skill_content(content: &str, opts: &LintOptions) -> Vec<LintFinding> {
    let (frontmatter, body) = match parse_frontmatter(content) {
        Ok(pair) => pair,
        Err(e) => return vec![LintFinding::error("frontmatter", e.0)],
    };

    let mut findings: Vec<LintFinding> = Vec::new();
    findings.extend(rules::check_name_format(frontmatter.name.as_deref()));
    findings.extend(rules::check_name_dir_mismatch(&frontmatter, opts));
    findings.extend(rules::check_description_length(&frontmatter));
    findings.extend(rules::check_description_marketing(&frontmatter));
    findings.extend(rules::check_missing_metadata(&frontmatter));
    findings.extend(rules::check_author_caps(&frontmatter));
    findings.extend(rules::check_shell_utility_reference(&frontmatter, &body));
    findings.extend(rules::check_missing_section(&frontmatter, &body));
    findings.extend(rules::check_dangling_reference(&frontmatter, &body, opts));
    findings.extend(rules::check_platforms_gating(&frontmatter, &body));
    findings.extend(rules::check_forbidden_file(&frontmatter, &body, opts));
    findings.extend(rules::check_platforms_value(&frontmatter));
    findings.extend(rules::check_related_skills(&frontmatter, &body, opts));
    findings
}

/// True if any finding has error severity.
pub fn has_errors(findings: &[LintFinding]) -> bool {
    findings.iter().any(|f| f.severity == LintSeverity::Error)
}

/// Human-readable summary of a flat findings list (mirrors `formatFindings`).
pub fn format_findings(findings: &[LintFinding]) -> String {
    findings
        .iter()
        .map(|f| {
            format!(
                "{} [{}] {}",
                if f.severity == LintSeverity::Error {
                    "✗"
                } else {
                    "⚠"
                },
                f.rule,
                f.message
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> LintOptions {
        LintOptions::default()
    }

    #[test]
    fn lint_skill_content_parses_and_runs_rules() {
        let content = r#"---
name: my-skill
description: A short description.
version: "1.0.0"
author: Jane Doe
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [demo]
---

# My Skill

## When to Use

Use it well.
"#;
        let findings = lint_skill_content(content, &opts());
        // Pass a clean skill: no findings except possibly missing-metadata is satisfied.
        assert!(
            findings.is_empty(),
            "expected no findings, got {:?}",
            findings
        );
    }

    #[test]
    fn frontmatter_error_becomes_error_finding() {
        let findings = lint_skill_content("no frontmatter here", &opts());
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].severity, LintSeverity::Error);
        assert_eq!(findings[0].rule, "frontmatter");
    }

    #[test]
    fn has_errors_detects_errors() {
        assert!(has_errors(&[LintFinding::error("x", "err")]));
        assert!(!has_errors(&[LintFinding::warning("x", "warn")]));
    }

    #[test]
    fn format_findings_uses_symbols() {
        let s = format_findings(&[
            LintFinding::error("e", "bad"),
            LintFinding::warning("w", "note"),
        ]);
        assert_eq!(s, "✗ [e] bad\n⚠ [w] note");
    }
}
