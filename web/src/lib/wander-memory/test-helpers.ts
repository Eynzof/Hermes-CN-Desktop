// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/test-helpers.ts — shared helpers for the opt-in tests that run
// against the REAL MemOS backend (web/src/lib/wander-memory/real-backend*.test.ts,
// mirroring the Rust crate's tests/real_backend.rs convention).
//
// Everything here talks to real processes only — no mocks:
//   • locate the WanderMemory checkout + its python interpreter
//     (WANDER_MEMORY_DIR / WANDER_MEMORY_PYTHON)
//   • start the dummy OpenAI LLM backend (WanderMemory's own
//     tests/dummy_openai_backend.DummyOpenAIBackend, scripted_responder from
//     tests/test_memory_remote_dryrun.py when importable, default responder
//     otherwise) and report its ephemeral port
//   • write a remote-backend config JSON for `python -m src.memory --remote`
//   • spawn the real MemOS CLI and wait for the `WM_PORTS=api,ws,fs` line +
//     a healthy GET /v1/health on the (possibly shifted) api port
//   • occupy loopback ports with throwaway net.Server listeners (used by the
//     port-shift scenario to force the CLI onto a shifted trio)
//
// Node/vitest has no `window`; the Hermes transport (fetchExternalJSON) guards
// on `window.hermesDesktop` before falling back to plain fetch. A self-
// referential shim keeps that code path working in unit tests without a
// browser (window.hermesDesktop is undefined → plain fetch).
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  (globalThis as Record<string, unknown>).window = globalThis;
}

const here = dirname(fileURLToPath(import.meta.url));
/** web/src/lib/wander-memory → desktop repo root. */
export const REPO_ROOT = resolve(here, '..', '..', '..', '..');

/**
 * The WanderMemory backend checkout. Env wins; the local default is the
 * port-shift worktree that carries the `--cors-origins` flag + the auto-shift
 * trio (C:\dev\wt\Wander-Memory-port-shift).
 */
export function wanderMemoryDir(): string {
  return process.env.WANDER_MEMORY_DIR ?? resolve(REPO_ROOT, '..', 'Wander-Memory-port-shift');
}

/**
 * The python interpreter that can run `python -m src.memory` from the
 * WanderMemory checkout. Env wins; defaults to `<dir>/.venv/Scripts/python.exe`
 * on win32 and `<dir>/.venv/bin/python` elsewhere. Returns null when the
 * interpreter does not exist (callers skip instead of failing).
 */
export function wanderMemoryPython(dir: string = wanderMemoryDir()): string | null {
  const fromEnv = process.env.WANDER_MEMORY_PYTHON;
  if (fromEnv) return fromEnv;
  const py =
    process.platform === 'win32'
      ? join(dir, '.venv', 'Scripts', 'python.exe')
      : join(dir, '.venv', 'bin', 'python');
  return existsSync(py) ? py : null;
}

/** The bound api/ws/fs ports of a running MemOS process. */
export interface MemOsPorts {
  api: number;
  ws: number;
  fs: number;
}

/** A running DummyOpenAIBackend process (the MemOS remote LLM). */
export interface DummyLlmHandle {
  child: ChildProcess;
  /** The backend's ephemeral port. */
  port: number;
  /** base_url including `/v1` — the `url` field of a remote config. */
  baseUrl: string;
}

/** A spawned `python -m src.memory --remote …` process. */
export interface MemOsProcessHandle {
  child: ChildProcess;
  ports: MemOsPorts;
}

/** A full self-hosted stack: dummy LLM + real MemOS CLI. */
export interface MemOsStack {
  llm: DummyLlmHandle;
  memos: MemOsProcessHandle;
  ports: MemOsPorts;
  runtimeDir: string;
  /** Gracefully stop both children (idempotent). */
  killAll(): Promise<void>;
}

// ── process plumbing ─────────────────────────────────────────────────────────

/** Wait for `re` on the child's stdout/stderr; reject on exit/error/timeout. */
export function waitForLine(
  child: ChildProcess,
  re: RegExp,
  label: string,
  timeoutMs = 60_000,
): Promise<{ line: string; match: RegExpExecArray }> {
  return new Promise((resolvePromise, reject) => {
    let buf = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      const match = re.exec(buf);
      if (match) {
        cleanup();
        resolvePromise({ line: match[0], match });
      }
    };
    const onExit = (code: number | null, signal: string | null) => {
      cleanup();
      reject(
        new Error(
          `${label}: process exited before the ready marker (code=${code}, signal=${signal}). Output so far:\n${buf.slice(0, 4000)}`,
        ),
      );
    };
    const onError = (err: Error) => {
      cleanup();
      reject(new Error(`${label}: failed to spawn: ${err.message}`));
    };
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `${label}: timed out after ${timeoutMs}ms waiting for ${String(re)}. Output so far:\n${buf.slice(0, 4000)}`,
        ),
      );
    }, timeoutMs);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

/** Kill a child and wait for its exit (SIGTERM then SIGKILL fallback). */
export function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 3000);
    child.once('exit', () => {
      clearTimeout(killer);
      resolvePromise();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  });
}

// ── health / ports ───────────────────────────────────────────────────────────

/** Plain-fetch GET /v1/health on the api port; resolves when it returns 2xx. */
export async function waitForHealth(
  apiPort: number,
  timeoutMs = 120_000,
  host = '127.0.0.1',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${host}:${apiPort}/v1/health`;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `timed out waiting for ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/** One-shot reachability check (no retry). */
export async function isReachable(origin: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const res = await fetch(`${origin.replace(/\/+$/, '')}/v1/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── port occupation (port-shift scenario) ────────────────────────────────────

export interface PortBlocker {
  servers: Server[];
  /** Destroy every accepted socket (aborted health probes linger on the
   *  server otherwise and server.close() never fires) then close the servers. */
  close(): Promise<void>;
}

/**
 * Bind throwaway TCP listeners on `ports` so the MemOS CLI sees the trio busy
 * and auto-shifts. Rejects when any port is already in use (e.g. an externally
 * started MemOS holds the default trio — callers skip in that case).
 */
export async function occupyPorts(ports: number[], host = '127.0.0.1'): Promise<PortBlocker> {
  const servers: Server[] = [];
  const sockets = new Set<import('node:net').Socket>();
  for (const port of ports) {
    const server = createServer();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(new Error(`port ${port} is already in use: ${err.message}`));
      };
      const onListening = () => {
        server.off('error', onError);
        resolvePromise();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    servers.push(server);
  }
  return {
    servers,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolvePromise) => {
              server.close(() => resolvePromise());
            }),
        ),
      );
    },
  };
}

// ── remote config + dummy LLM ────────────────────────────────────────────────

/** Write a remote-backend config JSON (model dummy, url, 4096 ctx). */
export function writeRemoteConfig(runtimeDir: string, llmBaseUrl: string): string {
  mkdirSync(runtimeDir, { recursive: true });
  const configPath = join(runtimeDir, 'remote-backend.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        model: 'dummy',
        url: llmBaseUrl,
        max_context_size: 4096,
        api_key: 'sk-dummy',
      },
      null,
      2,
    ),
  );
  return configPath;
}

const DUMMY_RUNNER_SOURCE = [
  'import sys, time',
  '# Written by Hermes test-helpers: drive WanderMemory tests/dummy_openai_backend.py',
  'WM = sys.argv[1]',
  'sys.path.insert(0, WM)',
  'sys.path.insert(0, WM + "/tests")',
  'from dummy_openai_backend import DummyOpenAIBackend, default_responder',
  'try:',
  '    from test_memory_remote_dryrun import scripted_responder',
  '    responder = scripted_responder',
  'except Exception as exc:',
  '    print(f"scripted_responder unavailable: {exc}", file=sys.stderr)',
  '    responder = default_responder',
  'b = DummyOpenAIBackend(responder=responder).start()',
  'print(f"DUMMY_LLM_PORT={b.port}", flush=True)',
  'while True:',
  '    time.sleep(1)',
].join('\n');

/**
 * Start WanderMemory's own DummyOpenAIBackend (with the dry-run suite's
 * scripted_responder when it imports, else the default responder) as a child
 * process and wait for its `DUMMY_LLM_PORT=` line.
 */
export async function startDummyLlm(options: {
  dir: string;
  python: string;
  runtimeDir: string;
}): Promise<DummyLlmHandle> {
  const { dir, python, runtimeDir } = options;
  mkdirSync(runtimeDir, { recursive: true });
  const scriptPath = join(runtimeDir, 'dummy_llm_runner.py');
  writeFileSync(scriptPath, DUMMY_RUNNER_SOURCE);
  const child = spawn(python, [scriptPath, dir], {
    cwd: runtimeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { match } = await waitForLine(
    child,
    /^DUMMY_LLM_PORT=(\d+)$/m,
    'dummy LLM backend',
    60_000,
  );
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0) {
    await killChild(child);
    throw new Error(`dummy LLM printed an invalid port: ${match[1]}`);
  }
  return { child, port, baseUrl: `http://127.0.0.1:${port}/v1` };
}

// ── MemOS CLI ────────────────────────────────────────────────────────────────

/** Spawn `python -m src.memory --remote <config> --db-path <db>` from the
 *  WanderMemory checkout and wait for the `WM_PORTS=api,ws,fs` publish line. */
export async function startMemOs(options: {
  dir: string;
  python: string;
  configPath: string;
  dbPath: string;
  corsOrigins?: string[];
  extraArgs?: string[];
}): Promise<MemOsProcessHandle> {
  const { dir, python, configPath, dbPath } = options;
  const args = ['-m', 'src.memory', '--remote', configPath, '--db-path', dbPath];
  if (options.corsOrigins && options.corsOrigins.length > 0) {
    args.push('--cors-origins', options.corsOrigins.join(','));
  }
  args.push(...(options.extraArgs ?? []));
  const child = spawn(python, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const { match } = await waitForLine(child, /^WM_PORTS=(\d+),(\d+),(\d+)$/m, 'MemOS WM_PORTS', 180_000);
  const ports: MemOsPorts = {
    api: Number(match[1]),
    ws: Number(match[2]),
    fs: Number(match[3]),
  };
  if (![ports.api, ports.ws, ports.fs].every((p) => Number.isInteger(p) && p > 0)) {
    await killChild(child);
    throw new Error(`MemOS published invalid WM_PORTS: ${match[0]}`);
  }
  return { child, ports };
}

/**
 * Start the whole stack (dummy LLM + real MemOS CLI) and wait for the API to
 * answer /v1/health. `dbPath` defaults to `<runtimeDir>/db`.
 */
export async function startMemOsStack(options: {
  dir?: string;
  python?: string | null;
  runtimeDir: string;
  dbPath?: string;
  corsOrigins?: string[];
  extraArgs?: string[];
}): Promise<MemOsStack> {
  const dir = options.dir ?? wanderMemoryDir();
  const python = options.python ?? wanderMemoryPython(dir);
  if (!python) {
    throw new Error(
      `no MemOS python interpreter found for ${dir}. Set WANDER_MEMORY_PYTHON (or create ${dir}/.venv).`,
    );
  }
  const runtimeDir = options.runtimeDir;
  const dbPath = options.dbPath ?? join(runtimeDir, 'db');
  const llm = await startDummyLlm({ dir, python, runtimeDir });
  try {
    const configPath = writeRemoteConfig(runtimeDir, llm.baseUrl);
    const memos = await startMemOs({
      dir,
      python,
      configPath,
      dbPath,
      corsOrigins: options.corsOrigins,
      extraArgs: options.extraArgs,
    });
    await waitForHealth(memos.ports.api);
    return {
      llm,
      memos,
      ports: memos.ports,
      runtimeDir,
      killAll: async () => {
        await killChild(memos.child);
        await killChild(llm.child);
      },
    };
  } catch (err) {
    await killChild(llm.child);
    throw err;
  }
}
