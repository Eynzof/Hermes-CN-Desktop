//! Desktop shell ↔ Core compatibility contract.
//!
//! Desktop and Core have independent version lines. The embedded JSON matrix
//! is shared with the renderer and release tooling so an update never assumes
//! that the two products must have the same SemVer.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

pub const COMPATIBILITY_MATRIX_SCHEMA_VERSION: u32 = 1;
pub const EMBEDDED_COMPATIBILITY_MATRIX_JSON: &str =
    include_str!("../compatibility/desktop-core.json");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityMatrix {
    pub schema_version: u32,
    pub rules: Vec<CompatibilityRule>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityRule {
    pub desktop_series: String,
    pub core_series: Vec<String>,
    #[serde(default)]
    pub runtime_manifest_schemas: Vec<u32>,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityMatch {
    pub desktop_series: String,
    pub core_series: String,
}

/// Return the numeric `major.minor` series of a SemVer-like version.
/// Prerelease/build suffixes and a leading `v` are accepted.
pub fn version_series(version: &str) -> Option<String> {
    let core = version
        .trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let _ = patch;
    Some(format!("{major}.{minor}"))
}

impl CompatibilityMatrix {
    pub fn parse_embedded() -> Result<Self, String> {
        let matrix: Self = serde_json::from_str(EMBEDDED_COMPATIBILITY_MATRIX_JSON)
            .map_err(|error| format!("兼容矩阵 JSON 无效：{error}"))?;
        matrix.validate()?;
        Ok(matrix)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != COMPATIBILITY_MATRIX_SCHEMA_VERSION {
            return Err(format!(
                "兼容矩阵 schemaVersion={}，期望 {}",
                self.schema_version, COMPATIBILITY_MATRIX_SCHEMA_VERSION
            ));
        }
        if self.rules.is_empty() {
            return Err("兼容矩阵至少需要一条规则".to_string());
        }

        let mut desktop_series_seen = BTreeSet::new();
        for rule in &self.rules {
            validate_series(&rule.desktop_series, "desktopSeries")?;
            if !desktop_series_seen.insert(rule.desktop_series.as_str()) {
                return Err(format!(
                    "兼容矩阵存在重复 desktopSeries：{}",
                    rule.desktop_series
                ));
            }
            if rule.core_series.is_empty() {
                return Err(format!(
                    "desktopSeries={} 至少需要一个 coreSeries",
                    rule.desktop_series
                ));
            }
            let mut core_series_seen = BTreeSet::new();
            for series in &rule.core_series {
                validate_series(series, "coreSeries")?;
                if !core_series_seen.insert(series.as_str()) {
                    return Err(format!(
                        "desktopSeries={} 存在重复 coreSeries：{}",
                        rule.desktop_series, series
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn rule_for_desktop(&self, desktop_version: &str) -> Option<&CompatibilityRule> {
        let desktop_series = version_series(desktop_version)?;
        self.rules
            .iter()
            .find(|rule| rule.desktop_series == desktop_series)
    }

    pub fn expected_core_series(&self, desktop_version: &str) -> Option<String> {
        self.rule_for_desktop(desktop_version).map(|rule| {
            rule.core_series
                .iter()
                .map(|series| format!("{series}.x"))
                .collect::<Vec<_>>()
                .join(" / ")
        })
    }

    pub fn check(
        &self,
        desktop_version: &str,
        core_version: &str,
    ) -> Result<CompatibilityMatch, String> {
        let desktop_series = version_series(desktop_version)
            .ok_or_else(|| format!("Desktop 版本格式无效：{desktop_version}"))?;
        let core_series = version_series(core_version)
            .ok_or_else(|| format!("Core 版本格式无效：{core_version}"))?;
        let rule = self
            .rules
            .iter()
            .find(|rule| rule.desktop_series == desktop_series)
            .ok_or_else(|| format!("兼容矩阵未声明 Desktop {desktop_series}.x"))?;
        if !rule.core_series.iter().any(|series| series == &core_series) {
            let expected = rule
                .core_series
                .iter()
                .map(|series| format!("{series}.x"))
                .collect::<Vec<_>>()
                .join(" / ");
            return Err(format!(
                "Desktop {desktop_series}.x 仅兼容 Core {expected}，目标为 Core {core_series}.x"
            ));
        }
        Ok(CompatibilityMatch {
            desktop_series,
            core_series,
        })
    }
}

fn validate_series(series: &str, label: &str) -> Result<(), String> {
    let mut parts = series.split('.');
    let valid = parts.next().is_some_and(|part| part.parse::<u64>().is_ok())
        && parts.next().is_some_and(|part| part.parse::<u64>().is_ok())
        && parts.next().is_none();
    if valid {
        Ok(())
    } else {
        Err(format!("{label} 必须是 major.minor，当前是 {series}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn embedded_matrix_is_valid() {
        let matrix = CompatibilityMatrix::parse_embedded().unwrap();
        assert_eq!(matrix.schema_version, 1);
        assert_eq!(matrix.rules.len(), 4);
    }

    #[test]
    fn version_series_accepts_prerelease_and_v_prefix() {
        assert_eq!(version_series("v0.8.1-hotupdate.1").as_deref(), Some("0.8"));
        assert_eq!(version_series("0.20.0+build.7").as_deref(), Some("0.20"));
        assert_eq!(version_series("0.20"), None);
        assert_eq!(version_series("not-a-version"), None);
    }

    #[test]
    fn desktop_08_accepts_core_020_series() {
        let matrix = CompatibilityMatrix::parse_embedded().unwrap();
        let matched = matrix.check("0.8.1-hotupdate.1", "0.20.9").unwrap();
        assert_eq!(matched.desktop_series, "0.8");
        assert_eq!(matched.core_series, "0.20");
        assert_eq!(
            matrix.expected_core_series("0.8.0-rc7").as_deref(),
            Some("0.20.x")
        );
    }

    #[test]
    fn incompatible_series_is_rejected() {
        let matrix = CompatibilityMatrix::parse_embedded().unwrap();
        let error = matrix.check("0.8.0", "0.19.9").unwrap_err();
        assert!(error.contains("仅兼容 Core 0.20.x"));
    }

    #[test]
    fn unknown_desktop_series_is_rejected() {
        let matrix = CompatibilityMatrix::parse_embedded().unwrap();
        let error = matrix.check("0.9.0", "0.21.0").unwrap_err();
        assert!(error.contains("未声明 Desktop 0.9.x"));
    }
}
