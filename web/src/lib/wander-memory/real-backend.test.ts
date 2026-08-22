// ─────────────────────────────────────────────────────────────────────────────
// real-backend.test.ts — the REAL MemOS backend counterpart of rest/ws/
// endpoints tests (which run against mocked transports). Mirrors the Rust
// crate's tests/real_backend.rs convention: the whole file is opt-in via
// WANDER_MEMORY_REAL_BACKEND=1, so `pnpm test:unit` stays green (hermetic CI)
// with no backend on the machine.
//
// When enabled the tests talk to the REAL Wander-Memory backend
// (python -m src.memory --remote <config> --db-path <dir>):
//
//   1. live contract — health (status ok + remote service fields) →
//      addMemory → search (finds the added text) → get → context → delete
//      (verify gone + GET 404) → chat (assistant reply through the remote
//      dummy LLM) → models/backends, plus a WebSocket round trip
//      (health op + streaming chat deltas over /v1/ws).
//      The backend is either an already-running one (WANDER_MEMORY_API_ORIGIN
//      env, or discoverable on 18400..18409) or — when the checkout + venv
//      exist — a self-spawned one (dummy LLM + `python -m src.memory`).
//
//   2. port-shift scenario — occupies 18400/18401/18402 with throwaway Node
//      net servers, spawns the REAL MemOS CLI (which must auto-shift to a
//      free trio), asserts `WM_PORTS=api,ws,fs` (ws==api+1, fs==api+2,
//      api != 18400), then runs the live contract against the SHIFTED ports
//      resolved through discovery (resolveEndpointsAsync finds the shifted
//      API). Skips with an actionable message when the default trio is
//      already taken by an externally running MemOS.
//
// Timeouts are generous (CLI boot + remote LLM calls); the file must also
// skip when WANDER_MEMORY_DIR / its python interpreter don't exist.
// ─────────────────────────────────────────────────────────────────────────────

// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemOsClient, type WanderMemoryClient } from './client';
import { resolveEndpointsAsync, type WanderMemoryEndpoints } from './endpoints';
import { MemOsRestClient } from './rest';
import { MemOsWsClient } from './ws';
import {
  isReachable,
  occupyPorts,
  startMemOsStack,
  wanderMemoryDir,
  wanderMemoryPython,
  type MemOsStack,
  type PortBlocker,
} from './test-helpers';

/** Whole-file opt-in gate (mirrors tests/real_backend.rs). */
const enabled = !!process.env.WANDER_MEMORY_REAL_BACKEND;
/** True when we can spawn the real MemOS stack (checkout + python exist). */
const canSpawnStack = wanderMemoryPython(wanderMemoryDir()) !== null;

const DEFAULT_TRIO = [18400, 18401, 18402] as const;

// ── shared contract steps (used by both the live-contract and the port-shift
//    scenario against whatever endpoints are in play) ────────────────────────

async function waitForWsOpen(ws: MemOsWsClient, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ws.connectionState === 'open') return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return ws.connectionState === 'open';
}

/** health → addMemory → search → get → context → delete → chat → models/backends. */
async function runRestContract(rest: MemOsRestClient): Promise<string> {
  // health: status ok + remote service fields (model, backend = client_type)
  const health = await rest.health();
  expect(health.status).toBe('ok');
  expect(health.model).toBe('dummy');
  expect(health.backend).toBe('openai_legacy');
  expect(health.backends).toEqual({});

  // addMemory → search (finds the added text) → get → context
  const marker = `rtm_memos_contract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const text = `用户对${marker}过敏——这是实时后端契约测试`;
  const added = await rest.addMemory(text, { type: 'fact' });
  expect(added.memory.memory).toContain(marker);
  expect(added.collision.stored_new).toBe(true);
  const id = added.memory.id;

  const searched = await rest.search(marker);
  expect(searched.results.some((r) => r.id === id)).toBe(true);

  const got = await rest.get(id);
  expect(got.memory.memory).toContain(marker);

  const ctx = await rest.context(marker);
  expect(ctx.context).toContain(marker);

  // delete → verify gone (search miss + GET 404)
  await rest.delete(id);
  const afterDelete = await rest.search(marker);
  expect(afterDelete.results.some((r) => r.id === id)).toBe(false);
  await expect(rest.get(id)).rejects.toMatchObject({ code: 'not_found' });

  // chat: assistant reply through the remote dummy LLM (deterministic text)
  const chatQuery = `请告诉我关于 ${marker} 的事情`;
  const chat = await rest.chat(chatQuery);
  expect(typeof chat.reply).toBe('string');
  expect(chat.reply.trim().length).toBeGreaterThan(0);
  expect(Array.isArray(chat.dreamed_keywords)).toBe(true);
  // the WanderMemory scripted responder echoes "你说的是：" + the query
  expect(chat.reply).toContain('你说的是');

  // models / backends introspection
  const models = await rest.models();
  expect(models.model).toBe('dummy');
  expect(models.reasoning).toBe('off');
  const backends = await rest.backends();
  expect(backends.remote).toBe(true);
  expect(backends.devices).toEqual([]);

  return marker;
}

/** WebSocket round trip: health op + streaming chat deltas over /v1/ws. */
async function runWsContract(ws: MemOsWsClient, marker: string): Promise<void> {
  ws.connect();
  expect(await waitForWsOpen(ws)).toBe(true);
  const wsHealth = await ws.health();
  expect(wsHealth.status).toBe('ok');
  expect(wsHealth.model).toBe('dummy');

  const deltas: string[] = [];
  const reply = await ws.chatStream(`ws 流式 ${marker} dream-me`, (d) => deltas.push(d));
  expect(deltas.length).toBeGreaterThan(0);
  expect(deltas.join('')).toContain('你说的是');
  expect(reply.reply.trim().length).toBeGreaterThan(0);
  expect(Array.isArray(reply.dreamed_keywords)).toBe(true);
  ws.disconnect();
}

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!enabled)('real MemOS backend (WANDER_MEMORY_REAL_BACKEND=1)', () => {
  // ── port-shift scenario (spawns its OWN real MemOS child) ────────────────
  describe('port-shift scenario', () => {
    describe.skipIf(!canSpawnStack)('auto-shift to a free trio + discovery', () => {
      let blockers: PortBlocker | null = null;
      let stack: MemOsStack | null = null;
      let runtimeDir = '';
      let skipReason: string | null = null;

      beforeAll(async () => {
        runtimeDir = mkdtempSync(join(tmpdir(), 'wm-port-shift-'));
        // Occupy the default trio so the CLI MUST shift. When the trio is
        // already taken (e.g. an externally started MemOS on 18400), skip —
        // the shift scenario needs the ports to be occupiable here.
        try {
          blockers = await occupyPorts([...DEFAULT_TRIO]);
        } catch (err) {
          skipReason =
            `cannot occupy the default trio 18400-18402 (${(err as Error).message}). ` +
            'Stop any running MemOS on those ports and re-run to exercise the shift.';
          return;
        }
        stack = await startMemOsStack({
          dir: wanderMemoryDir(),
          python: wanderMemoryPython(),
          runtimeDir,
        });
      }, 240_000);

      afterAll(async () => {
        await stack?.killAll();
        await blockers?.close();
        vi.unstubAllEnvs();
        try {
          rmSync(runtimeDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }, 60_000);

      it(
        'CLI shifts to a free trio and the client runs the contract via discovery',
        async (ctx) => {
          if (skipReason !== null) {
            ctx.skip(skipReason);
            return;
          }
          const active = stack!;
          const { ports } = active;

          // 1. trio invariant: ws==api+1, fs==api+2, api != 18400
          expect(ports.api).not.toBe(18400);
          expect(ports.ws).toBe(ports.api + 1);
          expect(ports.fs).toBe(ports.api + 2);

          // 2. the ports file lands next to the db path
          const portsFile = join(active.runtimeDir, 'db', 'wander_memory_ports.json');
          const published = JSON.parse(readFileSync(portsFile, 'utf8')) as {
            api: number;
            ws: number;
            fs: number;
          };
          expect(published).toEqual({ api: ports.api, ws: ports.ws, fs: ports.fs });

          // 3. discovery finds the SHIFTED api: stub any endpoint env vars
          //    empty so resolveEndpointsAsync() has to probe 18400..18409.
          vi.stubEnv('WANDER_MEMORY_API_ORIGIN', '');
          vi.stubEnv('WANDER_MEMORY_WS_URL', '');
          vi.stubEnv('WANDER_MEMORY_FS_ORIGIN', '');
          const discovered = await resolveEndpointsAsync();
          expect(discovered.apiOrigin).toBe(`http://127.0.0.1:${ports.api}`);
          expect(discovered.wsUrl).toBe(`ws://127.0.0.1:${ports.ws}/v1/ws`);
          expect(discovered.fsOrigin).toBe(`http://127.0.0.1:${ports.fs}`);

          // 4. the full live contract against the SHIFTED ports
          const rest = new MemOsRestClient(discovered.apiOrigin);
          const ws = new MemOsWsClient(discovered.wsUrl);
          const marker = await runRestContract(rest);
          await runWsContract(ws, marker);
        },
        180_000,
      );
    });
  });

  // ── live contract (already-running backend, or self-spawned on 18400) ─────
  describe('live contract', () => {
    let client: WanderMemoryClient | null = null;
    let eps: WanderMemoryEndpoints | null = null;
    let selfSpawned: MemOsStack | null = null;
    let runtimeDir = '';

    beforeAll(async () => {
      // env → ui-store → probe 18400..18409 (WANDER_MEMORY_API_ORIGIN wins).
      eps = await resolveEndpointsAsync();
      let reachable = await isReachable(eps.apiOrigin);
      if (!reachable && canSpawnStack) {
        // No backend is running — spawn our own on the default trio.
        runtimeDir = mkdtempSync(join(tmpdir(), 'wm-contract-'));
        selfSpawned = await startMemOsStack({
          dir: wanderMemoryDir(),
          python: wanderMemoryPython(),
          runtimeDir,
        });
        // Re-resolve so discovery records the now-reachable trio.
        eps = await resolveEndpointsAsync();
        reachable = await isReachable(eps.apiOrigin);
      }
      if (!reachable) {
        throw new Error(
          'no reachable MemOS backend. Start one on 18400 (dummy LLM + ' +
            'python -m src.memory --remote <cfg> --db-path <dir>) or set ' +
            'WANDER_MEMORY_API_ORIGIN; to let the test spawn its own, make ' +
            'sure WANDER_MEMORY_DIR/WANDER_MEMORY_PYTHON point at the checkout.',
        );
      }
      client = createMemOsClient(eps);
    }, 240_000);

    afterAll(async () => {
      client?.dispose?.();
      await selfSpawned?.killAll();
      try {
        rmSync(runtimeDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }, 60_000);

    it('full REST contract against the real backend', async () => {
      const rest = new MemOsRestClient(eps!.apiOrigin);
      await runRestContract(rest);
    }, 120_000);

    it('WebSocket protocol: health op + streaming chat deltas', async () => {
      const ws = new MemOsWsClient(eps!.wsUrl);
      await runWsContract(ws, `ws_marker_${Date.now()}`);
    }, 120_000);
  });
});
