/**
 * Capability / workflow gates for tool availability.
 *
 * Mirrors Python `tools/registry.py` check_fn behaviour:
 * - 30 s TTL cache for capability probes.
 * - 60 s "last-good" grace window so a flaky probe does not silently remove
 *   a tool mid-session.
 */

import type { ToolCheckFn, ToolContext } from "./types.js";

const TTL_MS = 30_000;
const GRACE_MS = 60_000;

interface ProbeRecord {
  status: boolean;
  checkedAt: number;
}

class CapabilityGateStore {
  private cache = new Map<string, ProbeRecord>();
  private inFlight = new Map<string, Promise<boolean>>();

  async check(name: string, probe: ToolCheckFn, ctx?: ToolContext): Promise<boolean> {
    const now = Date.now();
    const cached = this.cache.get(name);
    if (cached && now - cached.checkedAt < TTL_MS) {
      return cached.status;
    }

    let inflight = this.inFlight.get(name);
    if (!inflight) {
      inflight = Promise.resolve(probe(ctx)).catch(() => false);
      this.inFlight.set(name, inflight);
      inflight.then(
        (status) => {
          // Keep last-good result within grace window even if probe flips to false.
          if (!status && cached?.status && now - cached.checkedAt < GRACE_MS) {
            this.cache.set(name, { status: true, checkedAt: now });
          } else {
            this.cache.set(name, { status, checkedAt: now });
          }
        },
        () => {
          /* ignore */
        },
      ).finally(() => {
        this.inFlight.delete(name);
      });
    }
    return inflight;
  }

  /** Force the next probe to re-run. */
  invalidate(name?: string) {
    if (name) {
      this.cache.delete(name);
      this.inFlight.delete(name);
    } else {
      this.cache.clear();
      this.inFlight.clear();
    }
  }

  snapshot(): Map<string, ProbeRecord> {
    return new Map(this.cache);
  }
}

export const capabilityStore = new CapabilityGateStore();

/** Evaluate a single check function with caching. */
export async function checkCapability(
  name: string,
  probe: ToolCheckFn,
  ctx?: ToolContext,
): Promise<boolean> {
  return capabilityStore.check(name, probe, ctx);
}

/** True when all required env vars are non-empty. */
export function envGate(keys: string[], ctx?: Partial<ToolContext>): boolean {
  const env = ctx?.env ?? (typeof process !== "undefined" ? process.env : {});
  return keys.every((k) => {
    const v = env[k];
    return typeof v === "string" ? v.length > 0 : false;
  });
}

function envGateAny(keys: string[]): ToolCheckFn {
  return (ctx) => keys.some((k) => envGate([k], ctx));
}

/** Credential-based auto-enable probes (x_search, homeassistant, …). */
export const credentialGates: Record<string, ToolCheckFn> = {
  x_search: envGateAny(["XAI_API_KEY", "X_API_BEARER_TOKEN"]),
  homeassistant: envGateAny(["HOME_ASSISTANT_TOKEN", "HASS_TOKEN"]),
  spotify: (ctx) => envGate(["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"], ctx),
  browser: () => {
 // Local browser backend is always available as a fallback; cloud backends gate
 // themselves by environment inside the registry resolution.
 return true;
  },
  computer_use: () => {
    // CUA driver availability is platform-specific and off by default.
    return false;
  },
};

/** Convenience builder for env-key gates. */
export function requireEnv(...keys: string[]): ToolCheckFn {
  return (ctx) => envGate(keys, ctx);
}
