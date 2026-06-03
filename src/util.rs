// Small cross-cutting helpers shared across modules.

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
}
