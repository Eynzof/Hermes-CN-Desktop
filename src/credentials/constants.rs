//! TTL / prune / concurrency constants mirrored from
//! `packages/credential-pool/src/constants.ts`.

use crate::credentials::types::RotationStrategy;

/// 401 cooldown: 5 minutes, in ms.
pub const TTL_401: i64 = 300_000;
/// 429 / billing / rate-limit cooldown: 1 hour, in ms.
pub const TTL_429: i64 = 3_600_000;
/// Default cooldown: 1 hour, in ms.
pub const TTL_DEFAULT: i64 = 3_600_000;
/// Sole-credential cooldown: 60 seconds, in ms.
pub const TTL_SOLE: i64 = 60_000;
/// Window after which a DEAD credential may be pruned: 24 hours, in ms.
pub const PRUNE_DEAD_MS: i64 = 86_400_000;
/// Default ceiling on concurrent use of a single credential.
pub const DEFAULT_MAX_CONCURRENT: u32 = 1;

/// The four supported rotation strategies (exact TS order).
pub const STRATEGIES: [RotationStrategy; 4] = [
    RotationStrategy::FillFirst,
    RotationStrategy::RoundRobin,
    RotationStrategy::LeastUsed,
    RotationStrategy::Random,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ttl_401_is_5_minutes_in_ms() {
        assert_eq!(TTL_401, 300_000);
        assert_eq!(TTL_401, 5 * 60 * 1_000);
    }

    #[test]
    fn ttl_429_and_default_are_1_hour_in_ms() {
        assert_eq!(TTL_429, 3_600_000);
        assert_eq!(TTL_DEFAULT, 3_600_000);
        assert_eq!(TTL_429, TTL_DEFAULT);
        assert_eq!(TTL_429, 60 * 60 * 1_000);
    }

    #[test]
    fn ttl_sole_is_60_seconds_in_ms() {
        assert_eq!(TTL_SOLE, 60_000);
        assert_eq!(TTL_SOLE, 60 * 1_000);
    }

    #[test]
    fn prune_dead_window_is_24_hours_in_ms() {
        assert_eq!(PRUNE_DEAD_MS, 86_400_000);
        assert_eq!(PRUNE_DEAD_MS, 24 * 60 * 60 * 1_000);
    }

    #[test]
    fn default_max_concurrent_is_one() {
        assert_eq!(DEFAULT_MAX_CONCURRENT, 1);
    }

    #[test]
    fn ttl_ordering_is_sole_less_than_401_less_than_429() {
        assert!(TTL_SOLE < TTL_401);
        assert!(TTL_401 < TTL_429);
    }

    #[test]
    fn strategies_lists_exactly_the_four_supported_rotation_strategies() {
        assert_eq!(
            STRATEGIES,
            [
                RotationStrategy::FillFirst,
                RotationStrategy::RoundRobin,
                RotationStrategy::LeastUsed,
                RotationStrategy::Random,
            ]
        );
    }

    #[test]
    fn strategies_are_all_distinct() {
        let len = STRATEGIES.len();
        for i in 0..len {
            for j in (i + 1)..len {
                assert_ne!(STRATEGIES[i], STRATEGIES[j]);
            }
        }
    }
}
