// endpoints.test.ts — endpoint resolution precedence (env → ui-store →
// discovery → defaults), saveEndpoints round-trip, port-shift discovery via a
// fake ports file / fake health probe, and the WANDER_MEMORY_DISCOVERY=off
// escape hatch. Everything runs through injected dependencies — no real
// ui-store or network involved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_API_ORIGIN,
  DEFAULT_FS_ORIGIN,
  DEFAULT_WS_URL,
  UI_KEY_API_ORIGIN,
  UI_KEY_DISCOVERED,
  UI_KEY_FS_ORIGIN,
  UI_KEY_WS_URL,
  discoverEndpoints,
  resolveEndpoints,
  resolveEndpointsAsync,
  saveEndpoints,
  type EndpointDeps,
  type WanderMemoryEndpoints,
  type WanderMemoryPortsFile,
} from './endpoints';

/** In-memory fake of the ui-store kv surface. */
function fakeUiStore(seed: Record<string, unknown> = {}) {
  const kv = new Map<string, unknown>(Object.entries(seed));
  return {
    kv,
    readUiValue: <T,>(key: string, fallback: T): T => (kv.has(key) ? (kv.get(key) as T) : fallback),
    writeUiValue: (key: string, value: unknown) => void kv.set(key, value),
  };
}

function fakeDeps(overrides: Partial<EndpointDeps> & { ui?: ReturnType<typeof fakeUiStore> } = {}) {
  const ui = overrides.ui ?? fakeUiStore();
  return {
    readUiValue: overrides.readUiValue ?? ui.readUiValue,
    writeUiValue: overrides.writeUiValue ?? ui.writeUiValue,
    readPortsFile: overrides.readPortsFile ?? (async () => null),
    probeHealth: overrides.probeHealth ?? (async () => false),
    discoveryEnabled: overrides.discoveryEnabled,
  };
}

const recorded: { probed: string[] } = { probed: [] };
function recordingProbe(...okPorts: number[]) {
  recorded.probed = [];
  return vi.fn(async (url: string): Promise<boolean> => {
    recorded.probed.push(url);
    const port = Number(new URL(url).port);
    return okPorts.includes(port);
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  recorded.probed = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveEndpoints precedence (sync: env → ui-store → defaults)', () => {
  it('uses defaults when nothing is configured', () => {
    const eps = resolveEndpoints(fakeDeps());
    expect(eps).toEqual({
      apiOrigin: DEFAULT_API_ORIGIN,
      wsUrl: DEFAULT_WS_URL,
      fsOrigin: DEFAULT_FS_ORIGIN,
    });
  });

  it('runtime process.env beats ui-store and defaults', () => {
    vi.stubEnv('WANDER_MEMORY_API_ORIGIN', 'http://env.test:20000');
    vi.stubEnv('WANDER_MEMORY_WS_URL', 'ws://env.test:20001/v1/ws');
    vi.stubEnv('WANDER_MEMORY_FS_ORIGIN', 'http://env.test:20002');
    const ui = fakeUiStore({
      [UI_KEY_API_ORIGIN]: 'http://ui.test:1',
      [UI_KEY_WS_URL]: 'ws://ui.test:2/v1/ws',
      [UI_KEY_FS_ORIGIN]: 'http://ui.test:3',
    });
    expect(resolveEndpoints(fakeDeps({ ui }))).toEqual({
      apiOrigin: 'http://env.test:20000',
      wsUrl: 'ws://env.test:20001/v1/ws',
      fsOrigin: 'http://env.test:20002',
    });
  });

  it('VITE_* import.meta.env vars are honored too', () => {
    vi.stubEnv('VITE_WANDER_MEMORY_API_ORIGIN', 'http://vite.test:30000');
    expect(resolveEndpoints(fakeDeps()).apiOrigin).toBe('http://vite.test:30000');
  });

  it('ui-store overrides beat defaults', () => {
    const ui = fakeUiStore({
      [UI_KEY_API_ORIGIN]: 'http://ui.test:18410',
      [UI_KEY_WS_URL]: 'ws://ui.test:18411/v1/ws',
      [UI_KEY_FS_ORIGIN]: 'http://ui.test:18412',
    });
    expect(resolveEndpoints(fakeDeps({ ui }))).toEqual({
      apiOrigin: 'http://ui.test:18410',
      wsUrl: 'ws://ui.test:18411/v1/ws',
      fsOrigin: 'http://ui.test:18412',
    });
  });

  it('per-field fallback: a single override leaves the others at defaults', () => {
    const ui = fakeUiStore({ [UI_KEY_API_ORIGIN]: 'http://only.api:1' });
    const eps = resolveEndpoints(fakeDeps({ ui }));
    expect(eps.apiOrigin).toBe('http://only.api:1');
    expect(eps.wsUrl).toBe(DEFAULT_WS_URL);
    expect(eps.fsOrigin).toBe(DEFAULT_FS_ORIGIN);
  });
});

describe('saveEndpoints', () => {
  it('writes only the provided fields to the ui-store keys', () => {
    const ui = fakeUiStore();
    const deps = fakeDeps({ ui });
    saveEndpoints({ apiOrigin: 'http://saved.test:1', fsOrigin: 'http://saved.test:3' }, deps);
    expect(ui.readUiValue(UI_KEY_API_ORIGIN, undefined)).toBe('http://saved.test:1');
    expect(ui.readUiValue(UI_KEY_WS_URL, undefined)).toBeUndefined();
    expect(ui.readUiValue(UI_KEY_FS_ORIGIN, undefined)).toBe('http://saved.test:3');
  });

  it('round-trips through resolveEndpoints with the same injected store', () => {
    const ui = fakeUiStore();
    const deps = fakeDeps({ ui });
    saveEndpoints(
      { apiOrigin: 'http://rt.test:1', wsUrl: 'ws://rt.test:2/v1/ws', fsOrigin: 'http://rt.test:3' },
      deps,
    );
    expect(resolveEndpoints(deps)).toEqual({
      apiOrigin: 'http://rt.test:1',
      wsUrl: 'ws://rt.test:2/v1/ws',
      fsOrigin: 'http://rt.test:3',
    });
  });
});

describe('discoverEndpoints (ports file → probe)', () => {
  it('reads the ports file and maps api/ws/fs ports to origins', async () => {
    const portsFile: WanderMemoryPortsFile = { api: 18413, ws: 18414, fs: 18415 };
    const ui = fakeUiStore();
    const probe = recordingProbe();
    const eps = await discoverEndpoints(
      fakeDeps({ readPortsFile: async () => portsFile, probeHealth: probe, ui }),
    );
    expect(eps).toEqual({
      apiOrigin: 'http://127.0.0.1:18413',
      wsUrl: 'ws://127.0.0.1:18414/v1/ws',
      fsOrigin: 'http://127.0.0.1:18415',
    });
    expect(probe).not.toHaveBeenCalled();
    expect(ui.readUiValue(UI_KEY_DISCOVERED, null)).toEqual(eps);
  });

  it('falls through to the health probe when the ports file is unreadable', async () => {
    const probe = recordingProbe(18403);
    const eps = await discoverEndpoints(fakeDeps({ readPortsFile: async () => null, probeHealth: probe }));
    expect(eps).toEqual({
      apiOrigin: 'http://127.0.0.1:18403',
      wsUrl: 'ws://127.0.0.1:18404/v1/ws',
      fsOrigin: 'http://127.0.0.1:18405',
    });
    // probed every port in order, starting at 18400
    expect(recorded.probed[0]).toBe('http://127.0.0.1:18400/v1/health');
    expect(recorded.probed).toHaveLength(4); // 18400..18403
  });

  it('first success wins — a healthy default port short-circuits the range', async () => {
    const probe = recordingProbe(18400, 18405);
    const eps = await discoverEndpoints(fakeDeps({ probeHealth: probe }));
    expect(eps!.apiOrigin).toBe('http://127.0.0.1:18400');
    expect(recorded.probed).toHaveLength(1);
  });

  it('returns null when nothing is reachable', async () => {
    const probe = recordingProbe();
    const eps = await discoverEndpoints(fakeDeps({ probeHealth: probe }));
    expect(eps).toBeNull();
    expect(recorded.probed).toHaveLength(10); // 18400..18409
  });

  it('is skipped when discovery is disabled via deps', async () => {
    const probe = vi.fn(async () => true);
    const eps = await discoverEndpoints(fakeDeps({ probeHealth: probe, discoveryEnabled: false }));
    expect(eps).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('is skipped when WANDER_MEMORY_DISCOVERY=off', async () => {
    vi.stubEnv('WANDER_MEMORY_DISCOVERY', 'off');
    const probe = vi.fn(async () => true);
    const eps = await discoverEndpoints(fakeDeps({ probeHealth: probe }));
    expect(eps).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('resolveEndpointsAsync (env → ui-store → discovery → defaults)', () => {
  it('skips discovery when env covers all three fields', async () => {
    vi.stubEnv('WANDER_MEMORY_API_ORIGIN', 'http://env.test:1');
    vi.stubEnv('WANDER_MEMORY_WS_URL', 'ws://env.test:2/v1/ws');
    vi.stubEnv('WANDER_MEMORY_FS_ORIGIN', 'http://env.test:3');
    const probe = vi.fn(async () => true);
    const eps = await resolveEndpointsAsync(fakeDeps({ probeHealth: probe }));
    expect(eps).toEqual({
      apiOrigin: 'http://env.test:1',
      wsUrl: 'ws://env.test:2/v1/ws',
      fsOrigin: 'http://env.test:3',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('applies discovery when nothing is overridden', async () => {
    const probe = recordingProbe(18406);
    const eps = await resolveEndpointsAsync(fakeDeps({ probeHealth: probe }));
    expect(eps).toEqual({
      apiOrigin: 'http://127.0.0.1:18406',
      wsUrl: 'ws://127.0.0.1:18407/v1/ws',
      fsOrigin: 'http://127.0.0.1:18408',
    });
  });

  it('ui-store overrides win over discovery per field', async () => {
    const ui = fakeUiStore({ [UI_KEY_API_ORIGIN]: 'http://ui.test:1' });
    const probe = recordingProbe(18400);
    const eps = await resolveEndpointsAsync(fakeDeps({ probeHealth: probe, ui }));
    expect(eps.apiOrigin).toBe('http://ui.test:1'); // override
    expect(eps.wsUrl).toBe('ws://127.0.0.1:18401/v1/ws'); // discovered
    expect(eps.fsOrigin).toBe('http://127.0.0.1:18402'); // discovered
  });

  it('falls back to defaults when discovery finds nothing', async () => {
    const probe = recordingProbe();
    const eps = await resolveEndpointsAsync(fakeDeps({ probeHealth: probe }));
    expect(eps).toEqual({
      apiOrigin: DEFAULT_API_ORIGIN,
      wsUrl: DEFAULT_WS_URL,
      fsOrigin: DEFAULT_FS_ORIGIN,
    });
  });

  it('falls back to defaults when discovery is disabled via env', async () => {
    vi.stubEnv('WANDER_MEMORY_DISCOVERY', 'off');
    const probe = vi.fn(async () => true);
    const eps = await resolveEndpointsAsync(fakeDeps({ probeHealth: probe }));
    expect(eps).toEqual({
      apiOrigin: DEFAULT_API_ORIGIN,
      wsUrl: DEFAULT_WS_URL,
      fsOrigin: DEFAULT_FS_ORIGIN,
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('caches the discovered endpoints in ui-store', async () => {
    const ui = fakeUiStore();
    const probe = recordingProbe(18400);
    await resolveEndpointsAsync(fakeDeps({ probeHealth: probe, ui }));
    const cached = ui.readUiValue<WanderMemoryEndpoints | null>(UI_KEY_DISCOVERED, null);
    expect(cached).toEqual({
      apiOrigin: 'http://127.0.0.1:18400',
      wsUrl: 'ws://127.0.0.1:18401/v1/ws',
      fsOrigin: 'http://127.0.0.1:18402',
    });
  });
});
