//! Cron expression parsing + next-run calculation.
//!
//! Home for the deterministic next-run logic used by the `agent_core_cron_next`
//! Tauri command, replacing the old TS "+60s" stub with a real 5-field expansion.

pub mod next_run;

pub use next_run::{next_run_time, parse_cron_expression, CronExpression};
