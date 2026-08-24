//! Tool-kit: pure resolvers / builders that complement the shared `schema`
//! mirrors. Home for the JSON-schema builder, static toolset catalog +
//! resolvers, platform toolset policy, and the HA security guard.
//!
//! Pure functions/constants only — no state beyond lazy-static tables.

pub mod ha_security;
pub mod platform;
pub mod schema;
pub mod toolsets;
