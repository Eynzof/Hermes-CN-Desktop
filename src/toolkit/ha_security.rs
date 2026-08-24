//! Home Assistant security primitives (defense-in-depth mirror of
//! `homeassistant/security.ts`).
//!
//! Entity/service regexes, blocked domains, JSON-string `data` parsing. Pure
//! functions, no state except compiled regexes loaded once.

use std::sync::OnceLock;

use regex::Regex;

/// Domains blocked from service calls (same six as `security.ts`).
///
/// HA has no service-level ACL; this safety gate prevents arbitrary code
/// execution through powerful built-in integrations.
pub const BLOCKED_DOMAINS: [&str; 6] = [
    "shell_command",
    "command_line",
    "python_script",
    "pyscript",
    "hassio",
    "rest_command",
];

fn entity_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z_][a-z0-9_]*\.[a-z0-9_]+$").expect("valid entity id regex"))
}

fn service_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9_]*$").expect("valid service name regex"))
}

/// Validate an entity id. Rejects path-traversal attempts.
pub fn is_valid_entity_id(entity_id: &str) -> bool {
    entity_id_re().is_match(entity_id)
}

/// Validate a service name. Must be checked before the blocklist.
pub fn is_valid_service_name(service_name: &str) -> bool {
    service_name_re().is_match(service_name)
}

/// True if the domain is in the blocked service-call list.
pub fn is_blocked_domain(domain: &str) -> bool {
    BLOCKED_DOMAINS.contains(&domain)
}

/// Parse the `data` parameter when it arrives as a JSON string.
///
/// Empty string is treated as `None` to match Python's `orjson` behavior.
/// Objects are passed through; arrays / scalars / `null` / invalid JSON -> `None`.
pub fn parse_string_data(data: &serde_json::Value) -> Option<serde_json::Value> {
    match data {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return None;
            }
            match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(parsed) => match parsed {
                    serde_json::Value::Object(_) => Some(parsed),
                    _ => None,
                },
                Err(_) => None,
            }
        }
        serde_json::Value::Object(_) => Some(data.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn entity_id_accepts_valid_ids() {
        for id in [
            "light.living_room",
            "switch.kitchen",
            "sensor.outside_temperature",
            "binary_sensor.door",
            "climate.home",
            "_custom_domain.entity",
        ] {
            assert!(is_valid_entity_id(id), "expected {id} to be valid");
        }
    }

    #[test]
    fn entity_id_rejects_invalid_ids_and_traversal() {
        for id in [
            "light",
            "light.",
            ".entity",
            "Light.living_room",
            "light.living room",
            "light/living_room",
            "shell_command../light",
            "light..entity",
            "light.entity.extra",
            "../shell_command.run",
        ] {
            assert!(!is_valid_entity_id(id), "expected {id} to be invalid");
        }
    }

    #[test]
    fn service_name_accepts_valid_names() {
        for name in [
            "turn_on",
            "turn_off",
            "set_temperature",
            "reload",
            "execute",
            "a1_2",
        ] {
            assert!(is_valid_service_name(name), "expected {name} to be valid");
        }
    }

    #[test]
    fn service_name_rejects_invalid_names() {
        for name in [
            "Turn_on",
            "turn on",
            "turn-on",
            "1service",
            "service.test",
            "",
            "../light",
            "shell_command/../light",
        ] {
            assert!(
                !is_valid_service_name(name),
                "expected {name} to be invalid"
            );
        }
    }

    #[test]
    fn blocked_domains_contains_all_six() {
        assert_eq!(
            BLOCKED_DOMAINS,
            [
                "shell_command",
                "command_line",
                "python_script",
                "pyscript",
                "hassio",
                "rest_command"
            ]
        );
        for d in BLOCKED_DOMAINS {
            assert!(is_blocked_domain(d));
        }
    }

    #[test]
    fn blocked_domains_rejects_safe_domains() {
        for d in ["light", "switch", "climate", "persistent_notification"] {
            assert!(!is_blocked_domain(d));
        }
    }

    #[test]
    fn parse_string_data_none_for_undefined_null() {
        assert_eq!(parse_string_data(&serde_json::Value::Null), None);
    }

    #[test]
    fn parse_string_data_none_for_empty_string() {
        assert_eq!(
            parse_string_data(&serde_json::Value::String("".to_string())),
            None
        );
        assert_eq!(
            parse_string_data(&serde_json::Value::String("   ".to_string())),
            None
        );
    }

    #[test]
    fn parse_string_data_parses_valid_json_object() {
        let parsed = parse_string_data(&serde_json::Value::String(
            "{\"brightness_pct\": 50}".to_string(),
        ));
        assert_eq!(parsed, Some(serde_json::json!({ "brightness_pct": 50 })));
    }

    #[test]
    fn parse_string_data_passes_object_as_is() {
        let obj = serde_json::json!({ "brightness_pct": 50 });
        assert_eq!(parse_string_data(&obj), Some(obj));
    }

    #[test]
    fn parse_string_data_rejects_non_object_json() {
        for s in ["[1, 2, 3]", "\"string\"", "null", "123"] {
            assert_eq!(
                parse_string_data(&serde_json::Value::String(s.to_string())),
                None,
                "{s}"
            );
        }
    }

    #[test]
    fn parse_string_data_rejects_invalid_json() {
        assert_eq!(
            parse_string_data(&serde_json::Value::String("{not json}".to_string())),
            None
        );
    }

    #[test]
    fn parse_string_data_rejects_arrays_and_primitives() {
        assert_eq!(parse_string_data(&serde_json::json!(123)), None);
        assert_eq!(parse_string_data(&serde_json::json!([1, 2])), None);
        assert_eq!(parse_string_data(&serde_json::json!(true)), None);
    }
}
