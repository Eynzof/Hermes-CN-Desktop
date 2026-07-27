// Orchestrates the deterministic backend half of the E2E stack and stays alive
// (Playwright's webServer keeps this process running for the test session):
//
//   1. fresh runtime HERMES_HOME + config.yaml -> Core's "custom" provider
//      points at the local fake model (e2e/fake-model/server.py).
//   2. fake model server (uvicorn) on FAKE_MODEL_PORT.
//   3. Core dashboard (REST + /api/ws) on DASHBOARD_PORT.
//
// On SIGINT/SIGTERM (or when Playwright tears the webServer down) every child is
// killed. Run standalone for debugging: `node harness/start-backend.mjs`.
import { spawn, spawnSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CORE_DIR,
  VENV_PY,
  E2E_DIR,
  RUNTIME_DIR,
  HERMES_HOME,
  UPLOAD_DIR,
  PLUGIN_SOURCE_DIR,
  WEB_DIST,
  FAKE_MODEL_PORT,
  FAKE_MODEL_HEALTH,
  DASHBOARD_PORT,
  DASHBOARD_ORIGIN,
  configYaml,
  coreEnv,
} from "./config.mjs";
import { waitForHttp, waitForLine } from "./wait.mjs";

const children = [];

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: PLUGIN_SOURCE_DIR,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function preparePluginSource() {
  mkdirSync(PLUGIN_SOURCE_DIR, { recursive: true });
  writeFileSync(
    resolve(PLUGIN_SOURCE_DIR, "plugin.yaml"),
    [
      "name: e2e-installed-plugin",
      "version: 1.0.0",
      "description: E2E lifecycle plugin from a local Git repository.",
      "author: Hermes CN E2E",
      "kind: standalone",
      "provides_tools:",
      "  - e2e_echo",
      "requires_env:",
      "  - E2E_PLUGIN_TOKEN",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(PLUGIN_SOURCE_DIR, "__init__.py"),
    [
      "import os",
      "from pathlib import Path",
      "",
      "Path(os.environ['E2E_PLUGIN_IMPORT_MARKER']).write_text('imported', encoding='utf-8')",
      "",
      "def register(ctx):",
      "    ctx.register_tool(",
      "        name='e2e_echo',",
      "        toolset='plugin_e2e_installed_plugin',",
      "        schema={",
      "            'name': 'e2e_echo',",
      "            'description': 'Return a deterministic E2E response.',",
      "            'parameters': {'type': 'object', 'properties': {}},",
      "        },",
      "        handler=lambda _args: 'e2e-ok',",
      "        description='Return a deterministic E2E response.',",
      "    )",
      "",
    ].join("\n"),
  );
  runGit(["init", "--quiet", "--initial-branch=main"]);
  runGit(["config", "user.name", "Hermes E2E"]);
  runGit(["config", "user.email", "e2e@hermes.invalid"]);
  runGit(["add", "plugin.yaml", "__init__.py"]);
  runGit(["commit", "--quiet", "-m", "test: add lifecycle plugin"]);
}

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

async function main() {
  if (!existsSync(VENV_PY)) {
    throw new Error(
      `Core python not found at ${VENV_PY}. Set HERMES_CORE_DIR / HERMES_CORE_PYTHON.`,
    );
  }

  // 1. Clean, reproducible runtime dir.
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(HERMES_HOME, { recursive: true });
  mkdirSync(UPLOAD_DIR, { recursive: true });
  writeFileSync(resolve(HERMES_HOME, "config.yaml"), configYaml());
  preparePluginSource();

  // A deterministic agent-owned skill proves the desktop classifies skills
  // from the connected Core instead of falling back to its bundled runtime.
  const agentSkillDir = resolve(HERMES_HOME, "skills", "user", "e2e-agent-skill");
  mkdirSync(agentSkillDir, { recursive: true });
  writeFileSync(
    resolve(agentSkillDir, "SKILL.md"),
    [
      "---",
      "name: e2e-agent-skill",
      "description: E2E marker owned by the connected Core.",
      "category: testing",
      "---",
      "",
      "# Connected Core Skill",
      "",
      "E2E connected-Core markdown marker.",
      "",
    ].join("\n"),
  );

  // Stub SPA dist: index.html (token injected at `</head>`) + an assets dir the
  // dashboard StaticFiles mount requires to exist.
  mkdirSync(resolve(WEB_DIST, "assets"), { recursive: true });
  writeFileSync(
    resolve(WEB_DIST, "index.html"),
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>e2e</title></head><body>e2e backend stub</body></html>\n",
  );

  const env = coreEnv();

  // 2. Fake model server.
  const fake = spawnChild(
    "fake-model",
    VENV_PY,
    [
      "-m",
      "uvicorn",
      "server:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(FAKE_MODEL_PORT),
      "--log-level",
      "warning",
    ],
    { cwd: resolve(E2E_DIR, "fake-model"), env },
  );
  await waitForHttp(FAKE_MODEL_HEALTH, { timeoutMs: 30_000 });
  console.log(`[harness] fake model ready on :${FAKE_MODEL_PORT}`);

  // 3. Core dashboard. Readiness is the stdout line it prints when serving.
  const dash = spawnChild(
    "dashboard",
    VENV_PY,
    [
      "-m",
      "hermes_cli.main",
      "dashboard",
      "--host",
      "127.0.0.1",
      "--port",
      String(DASHBOARD_PORT),
      "--no-open",
      "--skip-build",
    ],
    { cwd: CORE_DIR, env },
  );
  await waitForLine(dash, `HERMES_DASHBOARD_READY port=${DASHBOARD_PORT}`, {
    timeoutMs: 120_000,
  });
  // Confirm the REST surface answers before we hand off to the browser tests.
  await waitForHttp(`${DASHBOARD_ORIGIN}/`, { timeoutMs: 30_000 }).catch(() => {});
  console.log(`[harness] dashboard ready on ${DASHBOARD_ORIGIN}`);
  console.log("[harness] BACKEND_READY");
}

main().catch((err) => {
  console.error("[harness] failed to start:", err.message);
  shutdown(1);
});
