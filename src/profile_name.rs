//! Shared Desktop-side Profile name validation.
//!
//! Core and the renderer accept 1–64 characters. Keeping every native entry
//! point on this single validator prevents switching, migration, and cron-run
//! proxy routes from drifting to a narrower limit.

use regex::Regex;
use std::sync::LazyLock;

static PROFILE_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$").expect("valid profile name regex")
});

pub(crate) fn is_valid_profile_name(name: &str) -> bool {
    PROFILE_NAME_RE.is_match(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_core_length_boundary() {
        assert!(is_valid_profile_name(&"a".repeat(64)));
        assert!(!is_valid_profile_name(&"a".repeat(65)));
    }

    #[test]
    fn rejects_unsafe_path_shapes() {
        for name in ["", "../profile", "a/b", "a b", "-leading", "_leading"] {
            assert!(
                !is_valid_profile_name(name),
                "unexpectedly accepted {name:?}"
            );
        }
    }
}
