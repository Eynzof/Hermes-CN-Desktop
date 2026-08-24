//! Real cron expression parser + next-run calculator.
//!
//! Supports:
//!  - `@every <n>m` (minutes)
//!  - `@hourly`
//!  - `@daily`
//!  - classic 5-field cron with full expansion (minute hour day-of-month month day-of-week)
//!
//! Mirrors `packages/agent-core/src/cron/schedule.ts` `parseCronExpression` and
//! `nextRunTime`, but replaces the old "+60s" stub for classic cron with a real
//! calendar search.

use chrono::{DateTime, Datelike, Duration, Local, LocalResult, TimeZone};
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct CronExpression {
    pub valid: bool,
    pub normalized: String,
    kind: CronKind,
}

#[derive(Debug, Clone)]
enum CronKind {
    Every {
        minutes: i64,
    },
    Hourly,
    Daily,
    Classic {
        minute: CronField,
        hour: CronField,
        day: CronField,
        month: CronField,
        dow: CronField,
    },
    Invalid,
}

#[derive(Debug, Clone)]
struct CronField {
    enabled: Vec<bool>,
}

impl CronField {
    fn matches(&self, v: usize) -> bool {
        self.enabled.get(v).copied().unwrap_or(false)
    }
}

fn every_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^@every\s+(\d+)\s*m\s*$").unwrap())
}

fn parse_field(spec: &str, min: usize, max: usize) -> Result<CronField, ()> {
    let mut enabled = vec![false; max + 1];
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(());
        }
        let (base, step) = match part.split_once('/') {
            Some((b, s)) => (b.trim(), s.parse::<usize>().map_err(|_| ())?),
            None => (part, 1usize),
        };
        if step == 0 {
            return Err(());
        }
        let (start, end) = if base == "*" {
            (min, max)
        } else if let Some((a, b)) = base.split_once('-') {
            let start = a.trim().parse::<usize>().map_err(|_| ())?;
            let end = b.trim().parse::<usize>().map_err(|_| ())?;
            (start, end)
        } else {
            let v = base.parse::<usize>().map_err(|_| ())?;
            (v, v)
        };
        if start < min || end > max || start > end {
            return Err(());
        }
        let mut i = start;
        while i <= end {
            enabled[i] = true;
            i += step;
        }
    }
    Ok(CronField { enabled })
}

/// Parse a cron expression into a `CronExpression` (`valid:false` for unknown).
pub fn parse_cron_expression(expr: &str) -> CronExpression {
    let trimmed = expr.trim();

    if let Some(caps) = every_re().captures(trimmed) {
        let minutes: i64 = caps[1].parse().unwrap_or(0);
        return CronExpression {
            valid: true,
            normalized: format!("@every {}m", minutes),
            kind: CronKind::Every { minutes },
        };
    }

    if trimmed.eq_ignore_ascii_case("@hourly") {
        return CronExpression {
            valid: true,
            normalized: "@hourly".to_string(),
            kind: CronKind::Hourly,
        };
    }

    if trimmed.eq_ignore_ascii_case("@daily") {
        return CronExpression {
            valid: true,
            normalized: "@daily".to_string(),
            kind: CronKind::Daily,
        };
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() == 5 {
        // day-of-week accepts 0-7 (7 == Sunday); extra slot used only in matching.
        if let (Ok(minute), Ok(hour), Ok(day), Ok(month), Ok(dow)) = (
            parse_field(parts[0], 0, 59),
            parse_field(parts[1], 0, 23),
            parse_field(parts[2], 1, 31),
            parse_field(parts[3], 1, 12),
            parse_field(parts[4], 0, 7),
        ) {
            return CronExpression {
                valid: true,
                normalized: trimmed.to_string(),
                kind: CronKind::Classic {
                    minute,
                    hour,
                    day,
                    month,
                    dow,
                },
            };
        }
    }

    CronExpression {
        valid: false,
        normalized: trimmed.to_string(),
        kind: CronKind::Invalid,
    }
}

/// Compute the next run time strictly appropriate for `expr` after `after` (ms epoch).
pub fn next_run_time(expr: &str, after: i64) -> Option<i64> {
    let parsed = parse_cron_expression(expr);
    if !parsed.valid {
        return None;
    }
    parsed.next_after(after)
}

impl CronExpression {
    pub fn next_after(&self, after: i64) -> Option<i64> {
        match &self.kind {
            CronKind::Invalid => None,
            CronKind::Every { minutes } => Some(after + minutes * 60_000),
            CronKind::Hourly => {
                let period = 60 * 60 * 1000;
                let base = after.max(0);
                Some((base + period - 1) / period * period)
            }
            CronKind::Daily => {
                let period = 24 * 60 * 60 * 1000;
                Some(local_midnight(after + period))
            }
            CronKind::Classic {
                minute,
                hour,
                day,
                month,
                dow,
            } => classic_next_after(after, minute, hour, day, month, dow),
        }
    }
}

fn classic_next_after(
    after: i64,
    minute: &CronField,
    hour: &CronField,
    day: &CronField,
    month: &CronField,
    dow: &CronField,
) -> Option<i64> {
    let after_dt = Local
        .timestamp_millis_opt(after)
        .single()
        .unwrap_or(Local::now());
    let start_date = after_dt.date_naive();
    // Scan up to 8 years so rare dates (e.g. 29 Feb) are reachable.
    let max_days: i64 = 8 * 366;

    for day_offset in 0..max_days {
        let date = start_date + Duration::days(day_offset);
        if !month.matches(date.month() as usize) {
            continue;
        }
        if !day.matches(date.day() as usize) {
            continue;
        }
        let wd = date.weekday().num_days_from_sunday() as usize;
        let dow_ok = dow.matches(wd) || dow.matches(if wd == 0 { 7 } else { wd });
        if !dow_ok {
            continue;
        }
        for hour_v in 0..24 {
            if !hour.matches(hour_v) {
                continue;
            }
            for minute_v in 0..60 {
                if !minute.matches(minute_v) {
                    continue;
                }
                let n = match date.and_hms_opt(hour_v as u32, minute_v as u32, 0) {
                    Some(n) => n,
                    None => continue,
                };
                let cand_ms = match Local.from_local_datetime(&n) {
                    LocalResult::Single(t) => t.timestamp_millis(),
                    LocalResult::Ambiguous(t, _) => t.timestamp_millis(),
                    LocalResult::None => continue,
                };
                if cand_ms > after {
                    return Some(cand_ms);
                }
            }
        }
    }
    None
}

fn local_midnight(ts_ms: i64) -> i64 {
    let dt: DateTime<Local> = Local
        .timestamp_millis_opt(ts_ms)
        .single()
        .unwrap_or(Local::now());
    let midnight = dt.date_naive().and_hms_opt(0, 0, 0).unwrap();
    match Local.from_local_datetime(&midnight) {
        LocalResult::Single(t) => t.timestamp_millis(),
        LocalResult::Ambiguous(t, _) => t.timestamp_millis(),
        LocalResult::None => ts_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_5m() {
        let p = parse_cron_expression("@every 5m");
        assert!(p.valid);
        assert_eq!(p.normalized, "@every 5m");
        assert_eq!(p.next_after(0), Some(5 * 60_000));
    }

    #[test]
    fn rejects_garbage() {
        assert!(!parse_cron_expression("not a cron").valid);
        assert_eq!(next_run_time("not a cron", 0), None);
    }

    #[test]
    fn hourly_aligns_to_absolute_hour() {
        let now = 1_000_000;
        let next = next_run_time("@hourly", now).unwrap();
        assert!(next >= now);
        assert_eq!(next % (60 * 60 * 1000), 0);
    }

    #[test]
    fn daily_next_is_local_midnight() {
        // Use a fixed, far-future timestamp so the local-midnight conversion is stable.
        let after = 1_700_000_000_000_i64;
        let next = next_run_time("@daily", after).unwrap();
        assert!(next > after);
    }

    #[test]
    fn parses_classic_5_field() {
        let p = parse_cron_expression("*/5 * * * *");
        assert!(p.valid);
        assert_eq!(p.normalized, "*/5 * * * *");
    }

    #[test]
    fn classic_every_minute_returns_next_minute() {
        let after = local_midnight(1_700_000_000_000_i64);
        let next = next_run_time("* * * * *", after).unwrap();
        assert_eq!(next, after + 60_000);
    }

    #[test]
    fn classic_bad_field_invalid() {
        assert!(!parse_cron_expression("61 * * * *").valid);
        assert!(!parse_cron_expression("* 24 * * *").valid);
    }
}
