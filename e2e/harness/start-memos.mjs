// Orchestrates the REAL MemOS backend half of the E2E stack and stays alive
// (Playwright's webServer keeps this process running for the test session).
// The deterministic Core backend is owned by start-backend.mjs — this harness
// only brings up the WanderMemory (MemOS) surface with a dummy OpenAI LLM:
//
//   1. fail fast when the default trio 18400/18401/18402 is occupied (E2E uses
//      the default trio; the auto-shift path is covered by the vitest
//      real-backend test, which occupies the trio itself).
//   2. remote config JSON (model dummy, url = dummy backend url,
//      max_context_size 4096, api_key sk-dummy) into the runtime dir.
//   3. dummy OpenAI backend (harness/dummy-memos-backend.py) →
//      DUMMY_LLM_PORT=<port>.
//   4. <WANDER_MEMORY_PYTHON> -m src.memory --remote <cfg> --db-path <data-dir>
//      --cors-origins <MEMOS_VITE_ORIGIN>[,http://127.0.0.1:9545]
//   5. wait for http://127.0.0.1:18400/v1/health (120 s; fail with the
//      captured log on timeout).
//   6. write e2e/.runtime/memos-ports.json + print MEMOS_READY + the WM_PORTS
//      line.
//
// On SIGINT/SIGTERM (or when Playwright tears the webServer down) every child
// is killed. Run standalone for debugging: `node harness/start-memos.mjs`.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { waitForHttp } from "./wait.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = resolve(__dirname, "..");
const DESKTOP_DIR = resolve(E2E_DIR, "..");

// The WanderMemory backend checkout (the port-shift/CORS branch). Defaults to
// the sibling checkout; override in CI (../Wander-Memory — resolved against
// the harness cwd, which Playwright sets to the config dir e2e/).
const WANDER_MEMORY_DIR = process.env.WANDER_MEMORY_DIR
  ? resolve(process.env.WANDER_MEMORY_DIR)
  : resolve(DESKTOP_DIR, "..", "Wander-Memory");
const WANDER_MEMORY_PYTHON =
  process.env.WANDER_MEMORY_PYTHON ||
  (process.platform === "win32"
    ? resolve(WANDER_MEMORY_DIR, ".venv", "Scripts", "python.exe")
    : resolve(WANDER_MEMORY_DIR, ".venv", "bin", "python"));
// Where MemOS persists its memory JSON (+ the ports file next to the db).
const MEMOS_DATA_DIR = process.env.MEMOS_DATA_DIR || resolve(E2E_DIR, ".runtime", "memos");
// The origin the Vite dev server serves the SPA from — MemOS answers CORS
// preflights for it (belt-and-suspenders: the REST calls are same-origin via
// the Vite proxy, but the WS + any direct cross-origin call stay open).
const MEMOS_VITE_ORIGIN = process.env.MEMOS_VITE_ORIGIN || "http://localhost:9545";

const MEMOS_RUNTIME_DIR = resolve(E2E_DIR, ".runtime");
const MEMOS_REMOTE_CONFIG = resolve(MEMOS_RUNTIME_DIR, "memos-remote.json");
const MEMOS_PORTS_FILE = resolve(MEMOS_RUNTIME_DIR, "memos-ports.json");
const DUMMY_BACKEND_SCRIPT = resolve(__dirname, "dummy-memos-backend.py");

const MEMOS_API_PORT = 18400;
const MEMOS_WS_PORT = 18401;
const MEMOS_FS_PORT = 18402;
const MEMOS_HEALTH_URL = `http://127.0.0.1:${MEMOS_API_PORT}/v1/health`;

const children = [];

function spawnChild(label, cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts });
  child.stdout?.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[harness] ${label} exited unexpectedly (code ${code})`);
      shutdown(1);
    }
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {}
  }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Wait for `re` on a child's stdout/stderr; captures the accumulated output so
// a boot failure can be reported with the real logs.
function waitForPattern(child, re, label, timeoutMs = 120_000) {
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `${label}: timed out after ${timeoutMs}ms waiting for ${String(re)}.\nCaptured output:\n${buf.slice(0, 8000)}`,
        ),
      );
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      const match = re.exec(buf);
      if (match) {
        cleanup();
        resolvePromise(match);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(
        new Error(
          `${label}: process exited (code ${code}) before the ready marker.\nCaptured output:\n${buf.slice(0, 8000)}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

// Fail fast if any default-trio port is already bound — unless
// MEMOS_REUSE_EXISTING=1, which means an external real backend (llama.cpp +
// local model) is already serving the default trio and should be reused as-is.
async function assertTrioFree() {
  const busy = [];
  for (const port of [MEMOS_API_PORT, MEMOS_WS_PORT, MEMOS_FS_PORT]) {
    const probe = createServer();
    const occupied = await new Promise((resolvePromise) => {
      probe.once("error", () => resolvePromise(true));
      probe.once("listening", () => probe.close(() => resolvePromise(false)));
      probe.listen(port, "127.0.0.1");
    });
    if (occupied) busy.push(port);
  }
  if (busy.length > 0) {
    throw new Error(
      `MemOS default trio ports ${busy.join(", ")} are already in use. ` +
        "The E2E harness uses the default trio (18400/18401/18402); stop the " +
        "other process first. (Port auto-shift is covered by the vitest " +
        "real-backend test.)",
    );
  }
}

async function main() {
  // MEMOS_REUSE_EXISTING=1: reuse a backend already running on the default
  // trio (real llama.cpp local model). Verify health, publish the ports file
  // and exit — the external process owns the trio.
  if (process.env.MEMOS_REUSE_EXISTING === "1") {
    await waitForHttp(MEMOS_HEALTH_URL, { timeoutMs: 30_000 });
    mkdirSync(MEMOS_RUNTIME_DIR, { recursive: true });
    writeFileSync(
      MEMOS_PORTS_FILE,
      JSON.stringify(
        {
          api: MEMOS_API_PORT,
          ws: MEMOS_WS_PORT,
          fs: MEMOS_FS_PORT,
          llm: "external",
          apiOrigin: `http://127.0.0.1:${MEMOS_API_PORT}`,
          wsUrl: `ws://127.0.0.1:${MEMOS_WS_PORT}/v1/ws`,
          fsOrigin: `http://127.0.0.1:${MEMOS_FS_PORT}`,
          reused: true,
        },
        null,
        2,
      ),
    );
    console.log(`[harness] reusing external MemOS on ${MEMOS_API_PORT}/${MEMOS_WS_PORT}/${MEMOS_FS_PORT}`);
    console.log(`[harness] MEMOS_READY`);
    // Keep the process alive so Playwright's webServer lifecycle stays intact.
    process.stdin.resume();
    const keepAlive = setInterval(() => {}, 1 << 30);
    process.on("SIGINT", () => { clearInterval(keepAlive); process.exit(0); });
    process.on("SIGTERM", () => { clearInterval(keepAlive); process.exit(0); });
    return;
  }

  if (!existsSync(WANDER_MEMORY_PYTHON)) {
    throw new Error(
      `WanderMemory python not found at ${WANDER_MEMORY_PYTHON}. ` +
        `Set WANDER_MEMORY_DIR (default ${WANDER_MEMORY_DIR}) / WANDER_MEMORY_PYTHON.`,
    );
  }
  await assertTrioFree();

  // 1. Clean, reproducible runtime dir + data dir.
  rmSync(MEMOS_DATA_DIR, { recursive: true, force: true });
  mkdirSync(MEMOS_RUNTIME_DIR, { recursive: true });
  mkdirSync(MEMOS_DATA_DIR, { recursive: true });

  // 2. Dummy OpenAI backend (WanderMemory's own DummyOpenAIBackend).
  const dummy = spawnChild(
    "dummy-llm",
    WANDER_MEMORY_PYTHON,
    [DUMMY_BACKEND_SCRIPT, WANDER_MEMORY_DIR],
    { cwd: E2E_DIR, env: { ...process.env, WANDER_MEMORY_DIR } },
  );
  const llmMatch = await waitForPattern(dummy, /^DUMMY_LLM_PORT=(\d+)$/m, "dummy LLM backend", 60_000);
  const llmBaseUrl = `http://127.0.0.1:${llmMatch[1]}/v1`;
  console.log(`[harness] dummy LLM ready at ${llmBaseUrl}`);

  // 3. Remote config JSON for `python -m src.memory --remote`.
  writeFileSync(
    MEMOS_REMOTE_CONFIG,
    JSON.stringify(
      {
        model: "dummy",
        url: llmBaseUrl,
        max_context_size: 4096,
        api_key: "sk-dummy",
      },
      null,
      2,
    ),
  );

  // 4. Real MemOS backend (port-shift/CORS branch).
  const memos = spawnChild(
    "memos",
    WANDER_MEMORY_PYTHON,
    [
      "-m",
      "src.memory",
      "--remote",
      MEMOS_REMOTE_CONFIG,
      "--db-path",
      MEMOS_DATA_DIR,
      "--cors-origins",
      `${MEMOS_VITE_ORIGIN},http://127.0.0.1:9545`,
    ],
    { cwd: WANDER_MEMORY_DIR, env: { ...process.env, WANDER_MEMORY_DIR } },
  );
  const wmMatch = await waitForPattern(memos, /^WM_PORTS=(\d+),(\d+),(\d+)$/m, "MemOS WM_PORTS", 120_000);
  const ports = { api: Number(wmMatch[1]), ws: Number(wmMatch[2]), fs: Number(wmMatch[3]) };

  // 5. Confirm the REST surface answers before handing off to the browser.
  await waitForHttp(MEMOS_HEALTH_URL, { timeoutMs: 120_000 });
  if (ports.api !== MEMOS_API_PORT) {
    throw new Error(
      `MemOS shifted to ${ports.api} but the E2E harness expects the default ` +
        `api port ${MEMOS_API_PORT} (ports were verified free at startup). ` +
        "Port auto-shift is covered by the vitest real-backend test.",
    );
  }

  // 6. Publish the bound ports for tools/debugging + signal readiness.
  writeFileSync(
    MEMOS_PORTS_FILE,
    JSON.stringify(
      {
        api: ports.api,
        ws: ports.ws,
        fs: ports.fs,
        llm: llmMatch[1],
        apiOrigin: `http://127.0.0.1:${ports.api}`,
        wsUrl: `ws://127.0.0.1:${ports.ws}/v1/ws`,
        fsOrigin: `http://127.0.0.1:${ports.fs}`,
      },
      null,
      2,
    ),
  );
  console.log(`[harness] MemOS ready on ${ports.api}/${ports.ws}/${ports.fs} (${MEMOS_VITE_ORIGIN})`);
  console.log(`[harness] WM_PORTS=${ports.api},${ports.ws},${ports.fs}`);
  console.log("[harness] MEMOS_READY");
}

main().catch((err) => {
  console.error("[harness] failed to start MemOS:", err.message);
  shutdown(1);
});
