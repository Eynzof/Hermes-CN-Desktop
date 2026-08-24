//! Hand-rolled CLI arg parsing for the skills-lint binary.
//!
//! Matches the TS `runCli` argument semantics:
//! - `--json` anywhere sets JSON output.
//! - `--source <dir> ...` collects the following values until the next `--flag`.
//! - If no sources are collected, the default root is `"."`.

/// Parsed CLI arguments.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CliArgs {
    /// Source directories to lint. Empty means "use default root `'.'`".
    pub sources: Vec<String>,
    /// Emit JSON output (`--json`).
    pub json: bool,
}

/// Parse raw argv (excluding the program name) into [`CliArgs`].
pub fn parse_args(argv: &[String]) -> CliArgs {
    let json = argv.iter().any(|a| a == "--json");
    let source_idx = argv.iter().position(|a| a == "--source");
    let mut sources = Vec::new();
    if let Some(idx) = source_idx {
        for arg in argv.iter().skip(idx + 1) {
            if arg.starts_with("--") {
                break;
            }
            sources.push(arg.clone());
        }
    }
    CliArgs { sources, json }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_flag_detected() {
        assert!(parse_args(&["--json".into()]).json);
        assert!(!parse_args(&["--source".into(), ".".into()]).json);
    }

    #[test]
    fn sources_stop_at_next_flag() {
        let args = vec![
            "--source".to_string(),
            "a".to_string(),
            "b".to_string(),
            "--json".to_string(),
            "c".to_string(),
        ];
        let parsed = parse_args(&args);
        assert_eq!(parsed.sources, vec!["a".to_string(), "b".to_string()]);
        assert!(parsed.json);
    }

    #[test]
    fn no_source_collected_when_absent() {
        let parsed = parse_args(&[".".to_string(), "x".to_string()]);
        assert!(parsed.sources.is_empty());
        assert!(!parsed.json);
    }
}
