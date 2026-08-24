//! `hermes-agent-cn-skills-lint` — Rust skills-lint CLI binary.
//!
//! Byte-compatible with the TS `packages/skill-lint` CLI contract:
//! `--source <dir>...`, `--json`, human summary, exit 1 on any error finding.

use std::path::PathBuf;
use std::process::ExitCode;

use hermes_agent_cn::skill_lint::{cli::parse_args, lint_tree, LintOptions};

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = parse_args(&argv);

    let roots: Vec<PathBuf> = if args.sources.is_empty() {
        vec![PathBuf::from(".")]
    } else {
        args.sources.iter().map(PathBuf::from).collect()
    };

    let result = lint_tree(&roots, &LintOptions::default());

    if args.json {
        match serde_json::to_string_pretty(&result) {
            Ok(text) => println!("{}", text),
            Err(e) => eprintln!("failed to serialize lint result: {}", e),
        }
    } else {
        print_summary(&result);
    }

    let has_errors = result
        .skills
        .iter()
        .flat_map(|s| s.findings.iter())
        .any(|f| f.severity == hermes_agent_cn::skill_lint::LintSeverity::Error);

    if has_errors {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn print_summary(result: &hermes_agent_cn::skill_lint::LintResult) {
    for skill in &result.skills {
        if skill.findings.is_empty() {
            continue;
        }
        println!("\n{}", skill.path);
        for f in &skill.findings {
            let mark = if f.severity == hermes_agent_cn::skill_lint::LintSeverity::Error {
                "✗"
            } else {
                "⚠"
            };
            println!("  {} [{}] {}", mark, f.rule, f.message);
        }
    }
    println!(
        "\nTotals: {} errors, {} warnings",
        result.totals.errors, result.totals.warnings
    );
}
