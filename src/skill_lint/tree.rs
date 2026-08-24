//! Real filesystem walker + disk-based lint checks for skill-lint.
//!
//! `lint_tree` discovers every `SKILL.md` under the given roots recursively,
//! reads and lints each, and adds the disk checks that the browser-safe TS
//! `lintTree` only stubs: `name-dir-mismatch` from the real directory basename,
//! `forbidden-file` (forbidden files present in the skill directory), and
//! `dangling-reference` (related skills that do not exist in the tree).

use std::path::{Path, PathBuf};

use crate::skill_lint::frontmatter::parse_frontmatter;
use crate::skill_lint::types::{
    LintFinding, LintOptions, LintResult, LintSeverity, SkillResult, Totals,
};
use crate::skill_lint::{lint_skill_content, SkillFrontmatter};
use walkdir::WalkDir;

const FORBIDDEN_FILES: &[&str] = &["README.md", "CHANGELOG.md", "install.sh", ".env"];

/// Walk `roots` recursively, lint every `SKILL.md`, and aggregate findings.
pub fn lint_tree(roots: &[PathBuf], opts: &LintOptions) -> LintResult {
    let mut skill_files: Vec<PathBuf> = Vec::new();
    for root in roots {
        for entry in WalkDir::new(root).follow_links(false).sort_by_file_name() {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if entry.file_type().is_file() && entry.file_name() == "SKILL.md" {
                skill_files.push(entry.into_path());
            }
        }
    }

    // First pass: collect every skill name so dangling references can resolve.
    let all_names: Vec<String> = collect_all_names(&skill_files);

    let mut skills: Vec<SkillResult> = Vec::new();
    let mut errors = 0usize;
    let mut warnings = 0usize;

    for path in &skill_files {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let skill_dir = path.parent().map(|p| p.to_path_buf());
        let mut skill_opts = opts.clone();
        skill_opts.skill_dir = skill_dir.as_ref().map(|d| d.to_string_lossy().to_string());
        skill_opts.all_names = Some(all_names.clone());

        let mut findings = lint_skill_content(&content, &skill_opts);
        if let Some(dir) = &skill_dir {
            findings.extend(forbidden_files_findings(dir));
            findings.extend(dangling_reference_findings(&content, &all_names));
        }

        for f in &findings {
            match f.severity {
                LintSeverity::Error => errors += 1,
                LintSeverity::Warning => warnings += 1,
            }
        }

        let name = parse_frontmatter(&content).ok().and_then(|(fm, _)| fm.name);
        skills.push(SkillResult {
            path: path.to_string_lossy().to_string(),
            name,
            findings,
        });
    }

    LintResult {
        version: 1,
        roots: roots
            .iter()
            .map(|r| r.to_string_lossy().to_string())
            .collect(),
        skills,
        totals: Totals { errors, warnings },
    }
}

fn collect_all_names(skill_files: &[PathBuf]) -> Vec<String> {
    let mut names = Vec::new();
    for path in skill_files {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok((fm, _)) = parse_frontmatter(&content) {
                if let Some(name) = fm.name {
                    names.push(name);
                }
            }
        }
    }
    names
}

/// Findings for forbidden files present in a skill directory.
fn forbidden_files_findings(dir: &Path) -> Vec<LintFinding> {
    let mut findings = Vec::new();
    for forbidden in FORBIDDEN_FILES {
        let candidate = dir.join(forbidden);
        if candidate.exists() {
            findings.push(LintFinding::error(
                "forbidden-file",
                format!("forbidden file '{}' present in skill directory", forbidden),
            ));
        }
    }
    findings
}

/// Findings for `related_skills` that do not resolve to any name in the tree.
fn dangling_reference_findings(content: &str, all_names: &[String]) -> Vec<LintFinding> {
    if all_names.is_empty() {
        return Vec::new();
    }
    let Ok((fm, _)) = parse_frontmatter(content) else {
        return Vec::new();
    };
    let related = related_skills(&fm);
    related
        .into_iter()
        .filter(|rel| !all_names.iter().any(|n| n == rel))
        .map(|rel| {
            LintFinding::warning(
                "dangling-reference",
                format!("related skill '{}' not found in the skill tree", rel),
            )
        })
        .collect()
}

fn related_skills(fm: &SkillFrontmatter) -> Vec<String> {
    fm.metadata
        .as_ref()
        .and_then(|m| m.hermes.as_ref())
        .and_then(|h| h.related_skills.clone())
        .or_else(|| fm.related_skills.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn lint_tree_discovers_skill_md_and_counts() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let skill_dir = root.join("my-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
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
---

# My Skill

## When to Use

Use it well.
"#,
        )
        .unwrap();

        let opts = LintOptions::default();
        let result = lint_tree(&[root.to_path_buf()], &opts);
        assert_eq!(result.skills.len(), 1);
        assert_eq!(result.totals.errors, 0);
        assert_eq!(result.totals.warnings, 0);
    }
}
