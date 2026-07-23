// Small cross-cutting helpers shared across modules.

use regex::Regex;
use std::sync::LazyLock;

static PROFILE_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$").expect("valid profile name regex")
});

/// Whether a string represents a truthy flag value.
///
/// Shared by environment-variable flags (`process::dashboard::env_flag`) and
/// persisted UI-store values (`ui_store::value_is_truthy`) so the accepted token
/// set stays identical no matter where the value comes from.
pub fn str_is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Whether a profile identifier is safe to pass between the renderer, shell,
/// and Core without becoming a path segment.
///
/// Core canonicalizes user input to lowercase before enforcing the same
/// 64-character limit. The shell deliberately accepts either case at ingress
/// because older callers may still pass a display-form name; all profile names
/// returned by Core are already canonical.
pub fn is_valid_profile_name(value: &str) -> bool {
    PROFILE_NAME_RE.is_match(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthy_tokens() {
        for v in ["1", "true", "TRUE", " on ", "Yes"] {
            assert!(str_is_truthy(v), "{v} should be truthy");
        }
        for v in ["0", "false", "off", "", "2", "no"] {
            assert!(!str_is_truthy(v), "{v} should be falsy");
        }
    }

    #[test]
    fn profile_name_contract_matches_core_length_and_path_safety() {
        for value in ["default", "reviewer", "qa-profile_2", "A"] {
            assert!(is_valid_profile_name(value), "{value} should be valid");
        }
        assert!(is_valid_profile_name(&"a".repeat(64)));

        for value in [
            "",
            "../reviewer",
            "reviewer/child",
            "reviewer child",
            "-reviewer",
            "_reviewer",
        ] {
            assert!(!is_valid_profile_name(value), "{value} should be invalid");
        }
        assert!(!is_valid_profile_name(&"a".repeat(65)));
    }
}
