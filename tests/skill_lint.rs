//! Integration tests for the Rust skills-lint module.
//!
//! Uses `tempfile::TempDir` per AGENTS.md (never write to `/tmp`, cwd, or fixed
//! paths). Runs against the public `hermes_agent_cn::skill_lint` API.

use hermes_agent_cn::skill_lint::{
    cli::parse_args, format_findings, has_errors, lint_skill_content, lint_tree, LintOptions,
    LintSeverity,
};
use tempfile::TempDir;

#[test]
fn lint_skill_content_clean_skill_has_no_findings() {
    let content = r#"---
name: sample-skill
description: A short, honest description.
version: "1.0.0"
author: Jane Doe
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [demo]
---

# Sample Skill

## When to Use

Use it wisely.
"#;
    let findings = lint_skill_content(content, &LintOptions::default());
    assert!(
        findings.is_empty(),
        "expected no findings, got {:?}",
        findings
    );
}

#[test]
fn frontmatter_missing_is_an_error() {
    let findings = lint_skill_content("just a body with no frontmatter", &LintOptions::default());
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].severity, LintSeverity::Error);
    assert_eq!(findings[0].rule, "frontmatter");
    assert!(has_errors(&findings));
}

#[test]
fn dangling_reference_and_forbidden_file_detected_by_tree() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let skill_dir = root.join("my-skill");
    std::fs::create_dir_all(&skill_dir).unwrap();
    // The skill declares a related skill that does not exist in the tree.
    std::fs::write(
        skill_dir.join("SKILL.md"),
        r#"---
name: my-skill
description: A short description.
version: "1.0.0"
author: Jane Doe
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [demo]
    related_skills: [ghost-skill]
---

# My Skill

## When to Use

Use it well.
"#,
    )
    .unwrap();
    // A forbidden file present in the skill directory.
    std::fs::write(skill_dir.join("README.md"), "# readme").unwrap();

    let result = lint_tree(&[root.to_path_buf()], &LintOptions::default());
    let skill = result
        .skills
        .iter()
        .find(|s| s.path.ends_with("SKILL.md"))
        .unwrap();
    let rules: Vec<&str> = skill.findings.iter().map(|f| f.rule.as_str()).collect();
    assert!(
        rules.contains(&"forbidden-file"),
        "expected forbidden-file finding, got {:?}",
        rules
    );
    assert!(
        rules.contains(&"dangling-reference"),
        "expected dangling-reference finding, got {:?}",
        rules
    );
    assert!(result.totals.errors >= 1);
    assert!(result.totals.warnings >= 1);
}

#[test]
fn cli_parse_args_stops_at_flag() {
    let args = vec![
        "--source".to_string(),
        "a".to_string(),
        "b".to_string(),
        "--json".to_string(),
    ];
    let parsed = parse_args(&args);
    assert_eq!(parsed.sources, vec!["a".to_string(), "b".to_string()]);
    assert!(parsed.json);
}

#[test]
fn format_findings_human_readable() {
    let s = format_findings(&[hermes_agent_cn::skill_lint::LintFinding::error(
        "name-format",
        "bad name",
    )]);
    assert!(s.contains("✗ [name-format] bad name"));
}

#[test]
fn skips_missing_file_in_tree() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let result = lint_tree(&[root.to_path_buf()], &LintOptions::default());
    // No SKILL.md files -> empty but valid result.
    assert_eq!(result.version, 1);
    assert!(result.skills.is_empty());
    assert_eq!(result.totals.errors, 0);
    assert_eq!(result.totals.warnings, 0);
}
