//! Optional Tauri IPC surface for skills-lint.
//!
//! The primary entry point is the `skills_lint` binary (`src/bin/skills_lint.rs`);
//! this command is only needed once the agent-core skills-loader migration routes
//! SKILL.md parsing/validation through Rust. It keeps the module pure (no
//! `tauri::State`) so it stays testable without a Tauri runtime.

use crate::error::AppError;
use crate::skill_lint::LintOptions;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLintContentResult {
    pub findings: Vec<crate::skill_lint::LintFinding>,
    pub has_errors: bool,
}

/// Lint a SKILL.md content string and return the findings.
#[tauri::command]
pub fn lint_skill_content(
    content: String,
    skill_dir: Option<String>,
    all_names: Option<Vec<String>>,
) -> Result<SkillLintContentResult, AppError> {
    let opts = LintOptions {
        skill_dir,
        all_names,
    };
    let findings = crate::skill_lint::lint_skill_content(&content, &opts);
    let has_errors = crate::skill_lint::has_errors(&findings);
    Ok(SkillLintContentResult {
        findings,
        has_errors,
    })
}
