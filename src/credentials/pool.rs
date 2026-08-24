//! In-memory credential pool, mirrored from
//! `packages/credential-pool/src/pool.rs`.
//!
//! The TS pool is single-threaded; in Rust the pool is intended to be wrapped
//! in a `Mutex`/`RwLock` by the caller (see plan §5 "State handling"). The
//! lease methods are kept no-op-compatible with the TS stubs until a consumer
//! defines lease semantics.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::credentials::constants::{TTL_401, TTL_429, TTL_DEFAULT, TTL_SOLE};
use crate::credentials::strategies::select_credential_index;
use crate::credentials::types::{FailureReason, LastStatus, PooledCredential, RotationStrategy};

/// Returns the current epoch-milliseconds clock (seam for deterministic tests).
fn now_ms_system() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A per-provider credential pool with rotation strategies.
///
/// Owns the live `entries` vector and advances a `cursor` /
/// `request_count` bookkeeping, exactly matching the TS `CredentialPool`.
pub struct CredentialPool {
    provider: String,
    entries: Vec<PooledCredential>,
    strategy: RotationStrategy,
    cursor: u64,
    /// Clock seam (`now_ms`), defaulting to the system clock. Tests replace it
    /// with a fake clock for deterministic assertions.
    now_ms: fn() -> i64,
}

impl CredentialPool {
    /// Create a new pool. `strategy` defaults to `fill_first` when omitted by
    /// the caller at the call site (the TS default).
    pub fn new(
        provider: String,
        entries: Vec<PooledCredential>,
        strategy: RotationStrategy,
    ) -> Self {
        Self {
            provider,
            entries,
            strategy,
            cursor: 0,
            now_ms: now_ms_system,
        }
    }

    /// The provider this pool serves.
    pub fn provider(&self) -> &str {
        &self.provider
    }

    /// Select the next credential, increment its `request_count`, and advance
    /// the cursor. Returns `None` when no entry is available.
    pub fn select(&mut self) -> Option<&PooledCredential> {
        let idx = select_credential_index(&self.entries, self.strategy, self.cursor as usize)?;
        self.entries[idx].request_count += 1;
        self.cursor += 1;
        Some(&self.entries[idx])
    }

    /// Mark the target credential (or the first available one when `id` is
    /// omitted) as exhausted, record the failure metadata, and return the next
    /// selected entry (may be `None`).
    ///
    /// Mirrors the TS behavior exactly:
    /// - `last_status` is set to `exhausted`;
    /// - `last_status_at` / `last_error_code` / `last_error_reason` are recorded;
    /// - `last_error_reset_at` is only set (to `now + TTL_SOLE`) in the
    ///   single-credential pool case.
    pub fn mark_exhausted_and_rotate(
        &mut self,
        status_code: Option<i64>,
        reason: Option<FailureReason>,
        credential_id: Option<&str>,
    ) -> Option<&PooledCredential> {
        let id = match credential_id {
            Some(id) => id.to_string(),
            None => {
                let available = self.entries.iter().find(|e| {
                    e.last_status != Some(LastStatus::Exhausted)
                        && e.last_status != Some(LastStatus::Dead)
                });
                match available {
                    Some(e) => e.id.clone(),
                    None => return None,
                }
            }
        };

        let now = (self.now_ms)();

        if let Some(entry) = self.entries.iter_mut().find(|e| e.id == id) {
            entry.last_status = Some(LastStatus::Exhausted);
            entry.last_status_at = Some(now);
            entry.last_error_code = status_code;
            entry.last_error_reason = reason;
        }

        if self.entries.len() == 1 && self.entries[0].id == id {
            self.entries[0].last_error_reset_at = Some(now + TTL_SOLE);
        }

        let ttl = self.compute_ttl(status_code, reason);
        let next = self.select();
        if next.is_none() && ttl != 0 {
            // No available entry; keep the current credential exhausted until TTL.
        }
        next
    }

    /// Select an entry and return its id. P1 keeps the TS no-op-compatible
    /// semantics (a lease is just a selection); the caller wrapping the pool in
    /// a `Mutex` provides the concurrency boundary.
    pub fn acquire_lease(&mut self) -> Option<String> {
        self.select().map(|e| e.id.clone())
    }

    /// Release a lease. No-op in this in-memory cut (P1); real lease semantics
    /// are a follow-up once a consumer defines them.
    pub fn release_lease(&mut self, _credential_id: &str) {
        // No-op.
    }

    /// The live entries vector as a slice (mirrors TS `entriesList()`).
    pub fn entries(&self) -> &[PooledCredential] {
        &self.entries
    }

    /// Whether any entry is not exhausted/dead.
    pub fn has_available(&self) -> bool {
        self.entries.iter().any(|e| {
            e.last_status != Some(LastStatus::Exhausted) && e.last_status != Some(LastStatus::Dead)
        })
    }

    /// The earliest `last_error_reset_at` among entries that have one, or
    /// `None` when no entry records a reset time.
    pub fn next_available_at(&self) -> Option<i64> {
        self.entries
            .iter()
            .filter_map(|e| e.last_error_reset_at)
            .min()
    }

    /// Compute the cooldown TTL for a failure, mirroring TS `computeTtl`.
    fn compute_ttl(&self, status_code: Option<i64>, reason: Option<FailureReason>) -> i64 {
        if status_code == Some(401) || reason == Some(FailureReason::Auth) {
            TTL_401
        } else if status_code == Some(429)
            || reason == Some(FailureReason::RateLimit)
            || reason == Some(FailureReason::Billing)
            || reason == Some(FailureReason::UpstreamRateLimit)
        {
            TTL_429
        } else {
            TTL_DEFAULT
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::constants::{TTL_401, TTL_429, TTL_SOLE};
    use crate::credentials::types::AuthType;

    // 2025-01-01T00:00:00Z in epoch ms.
    const FAKE_NOW_MS: i64 = 1_735_689_600_000;

    fn fake_now() -> i64 {
        FAKE_NOW_MS
    }

    fn make_cred(id: &str, overrides: impl FnOnce(&mut PooledCredential)) -> PooledCredential {
        let mut cred = PooledCredential {
            provider: "test".to_string(),
            id: id.to_string(),
            label: id.to_string(),
            auth_type: AuthType::ApiKey,
            priority: 0,
            source: "manual".to_string(),
            access_token: "secret".to_string(),
            refresh_token: None,
            last_status: None,
            last_status_at: None,
            last_error_code: None,
            last_error_reason: None,
            last_error_message: None,
            last_error_reset_at: None,
            base_url: None,
            expires_at: None,
            expires_at_ms: None,
            last_refresh: None,
            inference_base_url: None,
            agent_key: None,
            request_count: 0,
            extra: serde_json::Map::new(),
        };
        overrides(&mut cred);
        cred
    }

    fn make_pool(entries: Vec<PooledCredential>, strategy: RotationStrategy) -> CredentialPool {
        let mut pool = CredentialPool::new("test".to_string(), entries, strategy);
        pool.now_ms = fake_now;
        pool
    }

    #[test]
    fn select_by_fill_first_increments_request_count() {
        let entries = vec![
            make_cred("a", |c| c.request_count = 1),
            make_cred("b", |_| {}),
        ];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        let picked = pool.select();
        assert_eq!(picked.map(|e| e.id.as_str()), Some("b"));
        assert_eq!(picked.map(|e| e.request_count), Some(1));
        assert_eq!(pool.entries()[0].request_count, 1);
    }

    #[test]
    fn least_used_strategy_increments_picked_entry() {
        let entries = vec![
            make_cred("a", |c| c.request_count = 2),
            make_cred("b", |c| c.request_count = 5),
        ];
        let mut pool = make_pool(entries, RotationStrategy::LeastUsed);
        assert_eq!(pool.select().map(|e| e.id.as_str()), Some("a"));
        assert_eq!(pool.entries()[0].request_count, 3);
    }

    #[test]
    fn round_robin_advances_cursor_on_each_select() {
        let entries = vec![make_cred("a", |_| {}), make_cred("b", |_| {})];
        let mut pool = make_pool(entries, RotationStrategy::RoundRobin);
        assert_eq!(pool.select().map(|e| e.id.as_str()), Some("a"));
        assert_eq!(pool.select().map(|e| e.id.as_str()), Some("b"));
        assert_eq!(pool.select().map(|e| e.id.as_str()), Some("a"));
    }

    #[test]
    fn returns_null_when_every_entry_exhausted_or_dead() {
        let entries = vec![
            make_cred("a", |c| c.last_status = Some(LastStatus::Exhausted)),
            make_cred("b", |c| c.last_status = Some(LastStatus::Dead)),
        ];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        assert_eq!(pool.select(), None);
        assert_eq!(pool.has_available(), false);
    }

    #[test]
    fn never_selects_dead_credential() {
        let entries = vec![
            make_cred("a", |c| c.last_status = Some(LastStatus::Dead)),
            make_cred("b", |_| {}),
        ];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        assert_eq!(pool.select().map(|e| e.id.as_str()), Some("b"));
    }

    #[test]
    fn mark_exhausted_records_status_code_and_reason_then_rotates() {
        let entries = vec![make_cred("a", |_| {}), make_cred("b", |_| {})];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        let next =
            pool.mark_exhausted_and_rotate(Some(429), Some(FailureReason::RateLimit), Some("a"));
        assert_eq!(next.map(|e| e.id.as_str()), Some("b"));
        let a = &pool.entries()[0];
        assert_eq!(a.last_status, Some(LastStatus::Exhausted));
        assert_eq!(a.last_status_at, Some(FAKE_NOW_MS));
        assert_eq!(a.last_error_code, Some(429));
        assert_eq!(a.last_error_reason, Some(FailureReason::RateLimit));
    }

    #[test]
    fn mark_exhausted_defaults_to_first_available_when_id_omitted() {
        let entries = vec![make_cred("a", |_| {}), make_cred("b", |_| {})];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        let next = pool.mark_exhausted_and_rotate(Some(429), None, None);
        assert_eq!(next.map(|e| e.id.as_str()), Some("b"));
        assert_eq!(pool.entries()[0].last_status, Some(LastStatus::Exhausted));
    }

    #[test]
    fn mark_exhausted_returns_null_when_no_entry_available() {
        let entries = vec![
            make_cred("a", |c| c.last_status = Some(LastStatus::Dead)),
            make_cred("b", |c| c.last_status = Some(LastStatus::Exhausted)),
        ];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        assert_eq!(pool.mark_exhausted_and_rotate(Some(429), None, None), None);
    }

    #[test]
    fn sole_credential_stays_exhausted_and_records_60s_reset() {
        let entries = vec![make_cred("only", |_| {})];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        let next = pool.mark_exhausted_and_rotate(Some(401), None, Some("only"));
        assert_eq!(next, None);
        assert_eq!(pool.has_available(), false);
        let entry = &pool.entries()[0];
        assert_eq!(entry.last_status, Some(LastStatus::Exhausted));
        assert_eq!(entry.last_error_reset_at, Some(FAKE_NOW_MS + TTL_SOLE));
        assert_eq!(pool.next_available_at(), entry.last_error_reset_at);
    }

    #[test]
    fn records_401_and_429_cooldown_constants() {
        assert_eq!(TTL_401, 300_000);
        assert_eq!(TTL_429, 3_600_000);
    }

    #[test]
    fn multi_entry_exhaustion_does_not_set_reset_time() {
        let entries = vec![make_cred("a", |_| {}), make_cred("b", |_| {})];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        pool.mark_exhausted_and_rotate(Some(429), None, Some("a"));
        assert_eq!(pool.entries()[0].last_error_reset_at, None);
        assert_eq!(pool.next_available_at(), None);
    }

    #[test]
    fn rotates_to_next_available_when_several_exist() {
        let entries = vec![
            make_cred("a", |_| {}),
            make_cred("b", |_| {}),
            make_cred("c", |_| {}),
        ];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        assert_eq!(
            pool.mark_exhausted_and_rotate(Some(429), None, Some("a"))
                .map(|e| e.id.as_str()),
            Some("b")
        );
        assert_eq!(
            pool.mark_exhausted_and_rotate(Some(429), None, Some("b"))
                .map(|e| e.id.as_str()),
            Some("c")
        );
        assert_eq!(pool.has_available(), true);
    }

    #[test]
    fn rotating_dead_entry_still_flips_it_to_exhausted() {
        let entries = vec![
            make_cred("a", |c| c.last_status = Some(LastStatus::Dead)),
            make_cred("b", |_| {}),
        ];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        let next = pool.mark_exhausted_and_rotate(Some(401), None, Some("a"));
        assert_eq!(next.map(|e| e.id.as_str()), Some("b"));
        assert_eq!(pool.entries()[0].last_status, Some(LastStatus::Exhausted));
    }

    #[test]
    fn acquire_lease_selects_entry_and_returns_id() {
        let entries = vec![make_cred("a", |_| {}), make_cred("b", |_| {})];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        assert_eq!(pool.acquire_lease(), Some("a".to_string()));
        assert_eq!(pool.entries()[0].request_count, 1);
    }

    #[test]
    fn acquire_lease_returns_none_when_nothing_available() {
        let entries = vec![make_cred("a", |c| c.last_status = Some(LastStatus::Dead))];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        assert_eq!(pool.acquire_lease(), None);
    }

    #[test]
    fn release_lease_is_safe_noop() {
        let entries = vec![make_cred("a", |_| {})];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        pool.release_lease("a");
    }

    #[test]
    fn entries_returns_live_entries() {
        let entries = vec![make_cred("a", |_| {})];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        assert_eq!(pool.entries().len(), 1);
        // Mutations via the pool's own methods are visible through `entries`.
        pool.select();
        assert_eq!(pool.entries()[0].request_count, 1);
    }

    #[test]
    fn has_available_reflects_exhausted_dead_status() {
        let entries = vec![make_cred("a", |_| {}), make_cred("b", |_| {})];
        let mut pool = make_pool(entries, RotationStrategy::FillFirst);
        assert_eq!(pool.has_available(), true);
        pool.mark_exhausted_and_rotate(Some(429), None, Some("a"));
        assert_eq!(pool.has_available(), true);
        pool.mark_exhausted_and_rotate(Some(429), None, Some("b"));
        assert_eq!(pool.has_available(), false);
    }

    #[test]
    fn next_available_at_returns_earliest_reset_time() {
        let now = FAKE_NOW_MS;
        let entries = vec![
            make_cred("a", |c| c.last_error_reset_at = Some(now + 10_000)),
            make_cred("b", |c| c.last_error_reset_at = Some(now + 5_000)),
        ];
        let pool = make_pool(entries, RotationStrategy::FillFirst);
        assert_eq!(pool.next_available_at(), Some(now + 5_000));
    }

    #[test]
    fn next_available_at_ignores_entries_without_reset_time() {
        let now = FAKE_NOW_MS;
        let entries = vec![
            make_cred("a", |c| c.last_error_reset_at = Some(now + 10_000)),
            make_cred("b", |_| {}),
        ];
        let pool = make_pool(entries, RotationStrategy::FillFirst);
        assert_eq!(pool.next_available_at(), Some(now + 10_000));
    }

    #[test]
    fn next_available_at_returns_null_when_no_reset_time() {
        let entries = vec![make_cred("a", |_| {}), make_cred("b", |_| {})];
        let pool = make_pool(entries, RotationStrategy::FillFirst);
        assert_eq!(pool.next_available_at(), None);
    }
}
