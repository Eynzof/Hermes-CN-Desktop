// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/endpoints.ts — MemOS (WanderMemory) endpoint resolution.
//
// Resolution precedence (highest first):
//   1. env:   VITE_WANDER_MEMORY_API_ORIGIN / VITE_WANDER_MEMORY_WS_URL /
//             VITE_WANDER_MEMORY_FS_ORIGIN (import.meta.env) AND runtime
//             process.env equivalents WANDER_MEMORY_API_ORIGIN / … (both forms,
//             plan Appendix G.4)
//   2. ui-store overrides: wander-memory.apiOrigin / wander-memory.wsUrl /
//             wander-memory.fsOrigin (via readUiValue/writeUiValue)
//   3. port-shift discovery (plan Appendix L.3): <data_dir>/wander_memory_ports.json
//             → probe REST ports 18400..18409 with GET /v1/health (~300 ms);
//             wsUrl = apiPort+1, fsOrigin = apiPort+2. Result cached in ui-store.
//   4. defaults: http://127.0.0.1:18400 / ws://127.0.0.1:18401/v1/ws /
//             http://127.0.0.1:18402
//
// The module is fully testable via dependency injection: fake read/writeUiValue,
// a fake ports-file reader and a fake health probe can be passed in; discovery
// can be switched off with WANDER_MEMORY_DISCOVERY=off (or deps.discoveryEnabled).
// ─────────────────────────────────────────────────────────────────────────────

import { readUiValue as defaultReadUiValue, writeUiValue as defaultWriteUiValue } from '../ui-store';
import { fetchExternalJSON } from '../transport';
import type { HealthResponse } from './types';

export interface WanderMemoryEndpoints {
  apiOrigin: string;
  wsUrl: string;
  fsOrigin: string;
}

/** Content of <data_dir>/wander_memory_ports.json — the shifted port trio. */
export interface WanderMemoryPortsFile {
  api: number;
  ws: number;
  fs: number;
}

export const DEFAULT_API_ORIGIN = 'http://127.0.0.1:18400';
export const DEFAULT_WS_URL = 'ws://127.0.0.1:18401/v1/ws';
export const DEFAULT_FS_ORIGIN = 'http://127.0.0.1:18402';

/** ui-store keys for manual overrides and the discovery cache. */
export const UI_KEY_API_ORIGIN = 'wander-memory.apiOrigin';
export const UI_KEY_WS_URL = 'wander-memory.wsUrl';
export const UI_KEY_FS_ORIGIN = 'wander-memory.fsOrigin';
export const UI_KEY_DISCOVERED = 'wander-memory.discoveredEndpoints';

export const PROBE_PORTS_START = 18400;
export const PROBE_PORTS_END = 18409;
export const PROBE_TIMEOUT_MS = 300;

export interface EndpointDeps {
  readUiValue?: <T>(key: string, fallback: T) => T;
  writeUiValue?: (key: string, value: unknown) => void;
  /** Reads <data_dir>/wander_memory_ports.json; null/throw → fall through to probe. */
  readPortsFile?: () => Promise<WanderMemoryPortsFile | null>;
  /** Health probe for GET /v1/health on a candidate origin; true = reachable. */
  probeHealth?: (url: string) => Promise<boolean>;
  /** False skips discovery entirely (also via WANDER_MEMORY_DISCOVERY=off). */
  discoveryEnabled?: boolean;
}

interface ResolvedDeps {
  readUiValue: <T>(key: string, fallback: T) => T;
  writeUiValue: (key: string, value: unknown) => void;
  readPortsFile: () => Promise<WanderMemoryPortsFile | null>;
  probeHealth: (url: string) => Promise<boolean>;
  discoveryEnabled: boolean;
}

function envString(processName: string, viteName: string): string | undefined {
  const vite = (import.meta.env as Record<string, unknown>)[viteName];
  if (typeof vite === 'string' && vite) return vite;
  if (typeof process !== 'undefined') {
    const proc = (process.env as Record<string, string | undefined>)[processName];
    if (proc) return proc;
  }
  return undefined;
}

function envEndpoints(): Partial<WanderMemoryEndpoints> {
  return {
    apiOrigin: envString('WANDER_MEMORY_API_ORIGIN', 'VITE_WANDER_MEMORY_API_ORIGIN'),
    wsUrl: envString('WANDER_MEMORY_WS_URL', 'VITE_WANDER_MEMORY_WS_URL'),
    fsOrigin: envString('WANDER_MEMORY_FS_ORIGIN', 'VITE_WANDER_MEMORY_FS_ORIGIN'),
  };
}

/**
 * Default ports-file reader. The webview has no bridge for arbitrary local
 * file reads in this phase; the Rust command wiring the real
 * `<data_dir>/wander_memory_ports.json` is Phase 8 future work. Tests inject
 * a fake reader via EndpointDeps.
 */
async function defaultReadPortsFile(): Promise<WanderMemoryPortsFile | null> {
  return null;
}

async function defaultProbeHealth(url: string): Promise<boolean> {
  try {
    await fetchExternalJSON<HealthResponse>(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

function resolveDeps(deps?: EndpointDeps): ResolvedDeps {
  const discoveryDisabledByEnv =
    typeof process !== 'undefined' && process.env.WANDER_MEMORY_DISCOVERY === 'off';
  return {
    readUiValue: deps?.readUiValue ?? defaultReadUiValue,
    writeUiValue: deps?.writeUiValue ?? defaultWriteUiValue,
    readPortsFile: deps?.readPortsFile ?? defaultReadPortsFile,
    probeHealth: deps?.probeHealth ?? defaultProbeHealth,
    discoveryEnabled: deps?.discoveryEnabled ?? !discoveryDisabledByEnv,
  };
}

/**
 * Sync resolution: env → ui-store overrides → defaults. Discovery is async and
 * is applied by resolveEndpointsAsync() (or discoverEndpoints() directly).
 */
export function resolveEndpoints(deps?: EndpointDeps): WanderMemoryEndpoints {
  const d = resolveDeps(deps);
  const fromEnv = envEndpoints();
  return {
    apiOrigin: fromEnv.apiOrigin ?? d.readUiValue<string | undefined>(UI_KEY_API_ORIGIN, undefined) ?? DEFAULT_API_ORIGIN,
    wsUrl: fromEnv.wsUrl ?? d.readUiValue<string | undefined>(UI_KEY_WS_URL, undefined) ?? DEFAULT_WS_URL,
    fsOrigin: fromEnv.fsOrigin ?? d.readUiValue<string | undefined>(UI_KEY_FS_ORIGIN, undefined) ?? DEFAULT_FS_ORIGIN,
  };
}

/**
 * Full async resolution: env → ui-store overrides → port-shift discovery →
 * defaults. When every field is pinned by env/ui-store, discovery is skipped.
 */
export async function resolveEndpointsAsync(deps?: EndpointDeps): Promise<WanderMemoryEndpoints> {
  const d = resolveDeps(deps);
  const fromEnv = envEndpoints();
  const uiApi = d.readUiValue<string | undefined>(UI_KEY_API_ORIGIN, undefined);
  const uiWs = d.readUiValue<string | undefined>(UI_KEY_WS_URL, undefined);
  const uiFs = d.readUiValue<string | undefined>(UI_KEY_FS_ORIGIN, undefined);
  const overrides: Partial<WanderMemoryEndpoints> = {
    apiOrigin: fromEnv.apiOrigin ?? uiApi,
    wsUrl: fromEnv.wsUrl ?? uiWs,
    fsOrigin: fromEnv.fsOrigin ?? uiFs,
  };
  if (overrides.apiOrigin && overrides.wsUrl && overrides.fsOrigin) {
    return { apiOrigin: overrides.apiOrigin, wsUrl: overrides.wsUrl, fsOrigin: overrides.fsOrigin };
  }

  const discovered = d.discoveryEnabled ? await discoverEndpoints(deps) : null;
  const merged: WanderMemoryEndpoints = {
    apiOrigin: overrides.apiOrigin ?? discovered?.apiOrigin ?? DEFAULT_API_ORIGIN,
    wsUrl: overrides.wsUrl ?? discovered?.wsUrl ?? DEFAULT_WS_URL,
    fsOrigin: overrides.fsOrigin ?? discovered?.fsOrigin ?? DEFAULT_FS_ORIGIN,
  };
  return merged;
}

/**
 * Port-shift discovery (plan Appendix L.3): ports file first, then a health
 * probe over 18400..18409. Returns null when nothing is reachable or discovery
 * is disabled. Successful results are cached in ui-store for the Status view.
 */
export async function discoverEndpoints(deps?: EndpointDeps): Promise<WanderMemoryEndpoints | null> {
  const d = resolveDeps(deps);
  if (!d.discoveryEnabled) return null;

  // 1. ports file (<data_dir>/wander_memory_ports.json)
  try {
    const ports = await d.readPortsFile();
    if (ports && Number.isInteger(ports.api) && Number.isInteger(ports.ws) && Number.isInteger(ports.fs)) {
      const eps: WanderMemoryEndpoints = {
        apiOrigin: `http://127.0.0.1:${ports.api}`,
        wsUrl: `ws://127.0.0.1:${ports.ws}/v1/ws`,
        fsOrigin: `http://127.0.0.1:${ports.fs}`,
      };
      d.writeUiValue(UI_KEY_DISCOVERED, eps);
      return eps;
    }
  } catch {
    // unreadable ports file — fall through to probing
  }

  // 2. health probe over the default port range
  for (let port = PROBE_PORTS_START; port <= PROBE_PORTS_END; port += 1) {
    const url = `http://127.0.0.1:${port}/v1/health`;
    try {
      if (await d.probeHealth(url)) {
        const eps: WanderMemoryEndpoints = {
          apiOrigin: `http://127.0.0.1:${port}`,
          wsUrl: `ws://127.0.0.1:${port + 1}/v1/ws`,
          fsOrigin: `http://127.0.0.1:${port + 2}`,
        };
        d.writeUiValue(UI_KEY_DISCOVERED, eps);
        return eps;
      }
    } catch {
      // probe failure — try the next port
    }
  }
  return null;
}

/** Persist manual endpoint overrides to the ui-store. */
export function saveEndpoints(eps: Partial<WanderMemoryEndpoints>, deps?: EndpointDeps): void {
  const d = resolveDeps(deps);
  if (eps.apiOrigin !== undefined) d.writeUiValue(UI_KEY_API_ORIGIN, eps.apiOrigin);
  if (eps.wsUrl !== undefined) d.writeUiValue(UI_KEY_WS_URL, eps.wsUrl);
  if (eps.fsOrigin !== undefined) d.writeUiValue(UI_KEY_FS_ORIGIN, eps.fsOrigin);
}
