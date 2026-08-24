//! JSON-schema builder mirror of `catalog.ts`'s `objectSchema` / `zodToJsonSchema`.
//!
//! Deterministic, pure, no state. Output is a `serde_json::Value` identical in
//! shape to the TypeScript builder for the same Zod-shaped input. `BTreeMap`
//! gives stable key ordering so the emitted schemas are reproducible across
//! runs (the TS `Object.fromEntries` preserves insertion order; JSON key order
//! is not semantically significant here).

use std::collections::BTreeMap;

use serde_json::Value;

/// A minimal, serializable model of the subset of Zod schemas used by the
/// agent-tools catalog. The TS builder inspects `z._def.typeName`; this enum
/// mirrors those cases (`ZodString`, `ZodNumber`, `ZodBoolean`, `ZodArray`,
/// `ZodObject`, `ZodOptional`, `ZodEnum`, `ZodDefault`).
#[derive(Debug, Clone, PartialEq)]
pub enum ZodSchema {
    String { description: Option<String> },
    Number,
    Boolean,
    Array(Box<ZodSchema>),
    Object(BTreeMap<String, ZodSchema>),
    Optional(Box<ZodSchema>),
    Enum(Vec<String>),
    Default(Box<ZodSchema>),
}

/// Port of `catalog.objectSchema`.
///
/// Builds an OpenAI-style object schema:
/// `{ type: "object", properties, required, additionalProperties: false }`.
pub fn object_schema(shape: BTreeMap<String, Value>, required: Vec<String>) -> Value {
    let mut properties = serde_json::Map::new();
    for (k, v) in shape {
        properties.insert(k, v);
    }
    serde_json::json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

/// Port of `catalog.zodToJsonSchema`.
pub fn zod_to_json_schema(zt: &ZodSchema) -> Value {
    match zt {
        ZodSchema::String { description } => {
            let mut m = serde_json::Map::new();
            m.insert("type".to_string(), Value::String("string".to_string()));
            if let Some(d) = description {
                m.insert("description".to_string(), Value::String(d.clone()));
            }
            Value::Object(m)
        }
        ZodSchema::Number => serde_json::json!({ "type": "number" }),
        ZodSchema::Boolean => serde_json::json!({ "type": "boolean" }),
        ZodSchema::Array(inner) => {
            serde_json::json!({ "type": "array", "items": zod_to_json_schema(inner) })
        }
        ZodSchema::Object(shape) => {
            let required: Vec<String> = shape.keys().cloned().collect();
            let props: BTreeMap<String, Value> = shape
                .iter()
                .map(|(k, v)| (k.clone(), zod_to_json_schema(v)))
                .collect();
            object_schema(props, required)
        }
        ZodSchema::Optional(inner) => zod_to_json_schema(inner),
        ZodSchema::Enum(values) => serde_json::json!({ "type": "string", "enum": values }),
        ZodSchema::Default(inner) => zod_to_json_schema(inner),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn object_schema_matches_toolshape() {
        let shape = BTreeMap::from([
            (
                "action".to_string(),
                serde_json::json!({ "type": "string", "enum": ["add", "list"] }),
            ),
            (
                "content".to_string(),
                serde_json::json!({ "type": "string" }),
            ),
        ]);
        let out = object_schema(shape, vec!["action".to_string()]);
        assert_eq!(
            out,
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["add", "list"] },
                    "content": { "type": "string" }
                },
                "required": ["action"],
                "additionalProperties": false
            })
        );
    }

    #[test]
    fn zod_string_emits_description_when_present() {
        let zt = ZodSchema::String {
            description: Some("Todo action".to_string()),
        };
        assert_eq!(
            zod_to_json_schema(&zt),
            serde_json::json!({ "type": "string", "description": "Todo action" })
        );
        let no_desc = ZodSchema::String { description: None };
        assert_eq!(
            zod_to_json_schema(&no_desc),
            serde_json::json!({ "type": "string" })
        );
    }

    #[test]
    fn zod_primitive_types() {
        assert_eq!(
            zod_to_json_schema(&ZodSchema::Number),
            serde_json::json!({ "type": "number" })
        );
        assert_eq!(
            zod_to_json_schema(&ZodSchema::Boolean),
            serde_json::json!({ "type": "boolean" })
        );
    }

    #[test]
    fn zod_array_wraps_items() {
        let zt = ZodSchema::Array(Box::new(ZodSchema::String { description: None }));
        assert_eq!(
            zod_to_json_schema(&zt),
            serde_json::json!({ "type": "array", "items": { "type": "string" } })
        );
    }

    #[test]
    fn zod_object_builds_nested_schema() {
        let shape = BTreeMap::from([
            ("code".to_string(), ZodSchema::String { description: None }),
            (
                "language".to_string(),
                ZodSchema::Enum(vec!["rust".to_string(), "ts".to_string()]),
            ),
        ]);
        let zt = ZodSchema::Object(shape);
        assert_eq!(
            zod_to_json_schema(&zt),
            serde_json::json!({
                "type": "object",
                "properties": {
                    "code": { "type": "string" },
                    "language": { "type": "string", "enum": ["rust", "ts"] }
                },
                "required": ["code", "language"],
                "additionalProperties": false
            })
        );
    }

    #[test]
    fn zod_optional_and_default_unwrap() {
        assert_eq!(
            zod_to_json_schema(&ZodSchema::Optional(Box::new(ZodSchema::Boolean))),
            serde_json::json!({ "type": "boolean" })
        );
        assert_eq!(
            zod_to_json_schema(&ZodSchema::Default(Box::new(ZodSchema::Number))),
            serde_json::json!({ "type": "number" })
        );
    }

    #[test]
    fn zod_enum_emits_enum_values() {
        assert_eq!(
            zod_to_json_schema(&ZodSchema::Enum(vec![
                "add".to_string(),
                "list".to_string()
            ])),
            serde_json::json!({ "type": "string", "enum": ["add", "list"] })
        );
    }
}
