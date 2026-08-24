//! Pure credential-selection strategies, mirrored from
//! `packages/credential-pool/src/strategies.ts`.
//!
//! `select_credential` never returns `exhausted`/`dead` entries and returns
//! `None` when no entry is available. `fill_first` / `least_used` pick the
//! smallest `request_count` (first on ties); `round_robin` indexes the cursor
//! over the **available-only** list; `random` picks uniformly over available
//! entries; unknown strategies fall back to the first available entry.

use crate::credentials::types::{LastStatus, PooledCredential, RotationStrategy};

/// Select the next credential using the given strategy.
///
/// The `round_robin_cursor` is only consulted for [`RotationStrategy::RoundRobin`].
pub fn select_credential(
    entries: &[PooledCredential],
    strategy: RotationStrategy,
    round_robin_cursor: usize,
) -> Option<&PooledCredential> {
    let mut rng = seeded_rng();
    let idx = select_index_by(entries, strategy, round_robin_cursor, &mut |len| {
        rng.next_index(len)
    })?;
    Some(&entries[idx])
}

/// Like [`select_credential`] but returns the index into `entries` so the pool
/// core can mutate the picked entry's `request_count`.
pub(crate) fn select_credential_index(
    entries: &[PooledCredential],
    strategy: RotationStrategy,
    round_robin_cursor: usize,
) -> Option<usize> {
    let mut rng = seeded_rng();
    select_index_by(entries, strategy, round_robin_cursor, &mut |len| {
        rng.next_index(len)
    })
}

/// Core selection over an arbitrary random-index source (used by tests for
/// deterministic seeded RNG behavior).
fn select_index_by<R: FnMut(usize) -> usize>(
    entries: &[PooledCredential],
    strategy: RotationStrategy,
    round_robin_cursor: usize,
    rand_index: &mut R,
) -> Option<usize> {
    let available: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, e)| {
            e.last_status != Some(LastStatus::Exhausted) && e.last_status != Some(LastStatus::Dead)
        })
        .map(|(i, _)| i)
        .collect();

    if available.is_empty() {
        return None;
    }

    let pick = match strategy {
        RotationStrategy::FillFirst | RotationStrategy::LeastUsed => {
            let mut best = available[0];
            for &idx in &available[1..] {
                if entries[idx].request_count < entries[best].request_count {
                    best = idx;
                }
            }
            best
        }
        RotationStrategy::RoundRobin => {
            let len = available.len();
            available[round_robin_cursor % len]
        }
        RotationStrategy::Random => {
            let len = available.len();
            available[rand_index(len)]
        }
    };

    Some(pick)
}

/// Small deterministic PRNG (splitmix64) used to turn a seed into a uniform
/// index. The public selector seeds it from the OS RNG; tests seed it directly
/// for reproducible random picks.
#[derive(Clone, Copy)]
struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn next_index(&mut self, len: usize) -> usize {
        if len == 0 {
            0
        } else {
            (self.next_u64() % len as u64) as usize
        }
    }
}

fn seeded_rng() -> SplitMix64 {
    let mut buf = [0u8; 8];
    let seed = if getrandom::fill(&mut buf).is_ok() {
        u64::from_le_bytes(buf)
    } else {
        // A deterministic-but-valid fallback if the OS RNG is unavailable.
        0x4D59_5DF4_D0F3_3173
    };
    SplitMix64::new(seed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::types::LastStatus;

    fn make_cred(
        id: &str,
        request_count: u64,
        last_status: Option<LastStatus>,
    ) -> PooledCredential {
        PooledCredential {
            provider: "test".to_string(),
            id: id.to_string(),
            label: id.to_string(),
            auth_type: crate::credentials::types::AuthType::ApiKey,
            priority: 0,
            source: "manual".to_string(),
            access_token: "secret".to_string(),
            refresh_token: None,
            last_status,
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
            request_count,
            extra: serde_json::Map::new(),
        }
    }

    fn id_of(entry: Option<&PooledCredential>) -> Option<&str> {
        entry.map(|e| e.id.as_str())
    }

    #[test]
    fn returns_none_for_empty_list() {
        assert_eq!(select_credential(&[], RotationStrategy::FillFirst, 0), None);
    }

    #[test]
    fn fill_first_picks_fewest_requests() {
        let entries = vec![make_cred("a", 3, None), make_cred("b", 1, None)];
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::FillFirst, 0)),
            Some("b")
        );
    }

    #[test]
    fn fill_first_keeps_first_on_ties() {
        let entries = vec![make_cred("a", 1, None), make_cred("b", 1, None)];
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::FillFirst, 0)),
            Some("a")
        );
    }

    #[test]
    fn least_used_behaves_like_fill_first() {
        let entries = vec![
            make_cred("a", 5, None),
            make_cred("b", 2, None),
            make_cred("c", 9, None),
        ];
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::LeastUsed, 0)),
            Some("b")
        );
    }

    #[test]
    fn round_robin_walks_entries_with_cursor() {
        let entries = vec![
            make_cred("a", 0, None),
            make_cred("b", 0, None),
            make_cred("c", 0, None),
        ];
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::RoundRobin, 0)),
            Some("a")
        );
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::RoundRobin, 1)),
            Some("b")
        );
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::RoundRobin, 2)),
            Some("c")
        );
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::RoundRobin, 3)),
            Some("a")
        );
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::RoundRobin, 7)),
            Some("b")
        );
    }

    #[test]
    fn round_robin_ignores_exhausted_dead_when_advancing() {
        let entries = vec![
            make_cred("a", 0, Some(LastStatus::Exhausted)),
            make_cred("b", 0, None),
            make_cred("c", 0, Some(LastStatus::Dead)),
            make_cred("d", 0, None),
        ];
        // Available = [b, d]; cursor 3 -> 3 % 2 = 1 -> d.
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::RoundRobin, 3)),
            Some("d")
        );
    }

    #[test]
    fn random_returns_an_available_entry_and_is_seeded_deterministic() {
        let entries = vec![
            make_cred("a", 0, None),
            make_cred("b", 0, None),
            make_cred("c", 0, None),
        ];

        // Two seeded runs with the same seed produce the same pick (deterministic).
        let seeded = |seed: u64| {
            let mut rng = SplitMix64::new(seed);
            select_index_by(&entries, RotationStrategy::Random, 0, &mut |len| {
                rng.next_index(len)
            })
            .map(|i| &entries[i])
        };
        let first = seeded(42).map(|e| e.id.as_str());
        let second = seeded(42).map(|e| e.id.as_str());
        assert_eq!(first, second);
        assert!(matches!(first, Some("a") | Some("b") | Some("c")));

        // The public selector must return an available entry.
        let picked = id_of(select_credential(&entries, RotationStrategy::Random, 0));
        assert!(matches!(picked, Some("a") | Some("b") | Some("c")));
    }

    #[test]
    fn excludes_exhausted_entries_from_every_strategy() {
        let entries = vec![
            make_cred("a", 0, Some(LastStatus::Exhausted)),
            make_cred("b", 0, None),
        ];
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::FillFirst, 0)),
            Some("b")
        );
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::LeastUsed, 0)),
            Some("b")
        );
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::RoundRobin, 0)),
            Some("b")
        );
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::Random, 0)),
            Some("b")
        );
    }

    #[test]
    fn excludes_dead_entries_from_every_strategy() {
        let entries = vec![
            make_cred("a", 0, Some(LastStatus::Dead)),
            make_cred("b", 0, Some(LastStatus::Dead)),
        ];
        assert_eq!(
            select_credential(&entries, RotationStrategy::FillFirst, 0),
            None
        );
        assert_eq!(
            select_credential(&entries, RotationStrategy::LeastUsed, 0),
            None
        );
        assert_eq!(
            select_credential(&entries, RotationStrategy::RoundRobin, 0),
            None
        );
        assert_eq!(
            select_credential(&entries, RotationStrategy::Random, 0),
            None
        );
    }

    #[test]
    fn treats_ok_and_undefined_status_as_available() {
        let entries = vec![
            make_cred("a", 0, Some(LastStatus::Ok)),
            make_cred("b", 0, None),
        ];
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::FillFirst, 0)),
            Some("a")
        );
    }

    #[test]
    fn falls_back_to_first_available_for_unknown_strategy() {
        // There is no unknown variant, but the pool's default fallback is
        // fill_first; verify the selection still returns the first available.
        let entries = vec![make_cred("a", 0, None), make_cred("b", 0, None)];
        assert_eq!(
            id_of(select_credential(&entries, RotationStrategy::FillFirst, 0)),
            Some("a")
        );
    }

    #[test]
    fn does_not_mutate_entries() {
        let entries = vec![make_cred("a", 2, None), make_cred("b", 1, None)];
        let before = entries.clone();
        let _ = select_credential(&entries, RotationStrategy::LeastUsed, 0);
        assert_eq!(entries, before);
    }
}
