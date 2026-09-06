#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareLocalDevResources } from "./prepare-local-dev-resources.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipInstall = process.env.HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL === "1";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function defaultSourceRoot() {
  const preferred = resolve(repoRoot, "../Hermes-CN-Core");
  if (existsSync(preferred)) return preferred;
  return resolve(repoRoot, "../hermes-agent-cn");
}

const sourceRoot = resolve(
  repoRoot,
  argValue("--source") ?? process.env.HERMES_AGENT_CN_SOURCE ?? defaultSourceRoot(),
);

function devRuntimeRoot() {
  if (process.env.HERMES_DESKTOP_RUNTIME_ROOT) {
    return resolve(process.env.HERMES_DESKTOP_RUNTIME_ROOT);
  }
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
        : process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "cn.org.hermesagent.desktop", "dev-runtime");
}

function currentRuntimePython() {
  try {
    const current = JSON.parse(readFileSync(join(devRuntimeRoot(), "current.json"), "utf8"));
    if (typeof current?.executablePath !== "string") return null;
    const binDir = dirname(current.executablePath);
    const python = join(binDir, process.platform === "win32" ? "python.exe" : "python");
    return existsSync(python) ? python : null;
  } catch {
    return null;
  }
}

function embeddedInterpreterEnv() {
  if (process.env.HERMES_DESKTOP_EMBEDDED_PYTHON !== "1") return {};

  const sourceVenvPython = join(
    sourceRoot,
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
  const python =
    process.env.PYO3_PYTHON ??
    currentRuntimePython() ??
    (existsSync(sourceVenvPython) ? sourceVenvPython : null);
  if (!python) return {};

  const probe = spawnSync(
    python,
    [
      "-c",
      "import json, sysconfig; p=sysconfig.get_paths(); print(json.dumps([p.get('purelib'), p.get('platlib')]))",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false },
  );
  if (probe.status !== 0) {
    throw new Error(
      `failed to inspect embedded Python environment ${python}: ${probe.stderr.trim()}`,
    );
  }
  const dependencyPaths = JSON.parse(probe.stdout.trim()).filter(
    (entry, index, entries) =>
      typeof entry === "string" && existsSync(entry) && entries.indexOf(entry) === index,
  );
  return {
    PYO3_PYTHON: python,
    PYTHONPATH: [...dependencyPaths, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  };
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pnpm tauri:dev[:managed] [--source ../Hermes-CN-Core] [--force]

Installs Hermes-CN-Core into the desktop managed runtime folder, then starts
Tauri dev with external PATH hermes fallback disabled. Missing Core Dashboard
and TUI assets are built automatically, and all local resources are injected
into the managed desktop process.`);
  process.exit(0);
}

function runNodeScript(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!skipInstall) {
  runNodeScript(resolve(repoRoot, "scripts", "install-local-runtime.mjs"), process.argv.slice(2));
}

const localResources = prepareLocalDevResources({
  sourceRoot,
  nodeExecutable: process.execPath,
});

function envDefault(name, fallback) {
  return process.env[name] ?? fallback;
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// Embedded Python mode needs the real pyo3 backend, which lives behind the
// (non-default) `embedded-python` cargo feature. Without it the crate compiles
// the stub backend and bootstrap falls back to the subprocess dashboard.
const devArgs = ["exec", "tauri", "dev"];
if (process.env.HERMES_DESKTOP_EMBEDDED_PYTHON === "1") {
  devArgs.push("--features", "embedded-python");
}
const embeddedPayload =
  process.env.HERMES_DESKTOP_EMBEDDED_PAYLOAD ??
  [
    resolve(sourceRoot, "hermes_embedded"),
    resolve(repoRoot, "hermes_backend", "hermes_embedded"),
    resolve(repoRoot, "..", "Hermes-CN-Core", "hermes_embedded"),
  ].find((candidate) => existsSync(resolve(candidate, "api.py")));
const embeddedPythonEnv = embeddedInterpreterEnv();
const child = spawn(pnpm, devArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  // Windows cannot execute .cmd files directly through CreateProcess; without
  // a command shell Node reports spawn EINVAL before Tauri starts.
  shell: process.platform === "win32",
  env: {
    ...process.env,
    // Dev kernels live under dev-runtime/ so they never overwrite the packaged
    // app's production runtime/current.json.
    HERMES_DESKTOP_RUNTIME_ROOT: envDefault("HERMES_DESKTOP_RUNTIME_ROOT", devRuntimeRoot()),
    HERMES_DESKTOP_PRESERVE_LOCAL_RUNTIME: envDefault("HERMES_DESKTOP_PRESERVE_LOCAL_RUNTIME", "1"),
    // Default dev mode now exercises the same managed runtime path as the
    // packaged app. Use HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD=1 only when you
    // deliberately want to attach to a separately started dashboard.
    HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT: envDefault("HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT", "0"),
    HERMES_DASHBOARD_TUI: envDefault("HERMES_DASHBOARD_TUI", "1"),
    HERMES_DESKTOP_DASHBOARD_WEB_DIST_DIR: envDefault(
      "HERMES_DESKTOP_DASHBOARD_WEB_DIST_DIR",
      localResources.HERMES_DESKTOP_DASHBOARD_WEB_DIST_DIR,
    ),
    HERMES_DESKTOP_BUNDLED_SKILLS_DIR: envDefault(
      "HERMES_DESKTOP_BUNDLED_SKILLS_DIR",
      localResources.HERMES_DESKTOP_BUNDLED_SKILLS_DIR,
    ),
    HERMES_DESKTOP_BUNDLED_PLUGINS_DIR: envDefault(
      "HERMES_DESKTOP_BUNDLED_PLUGINS_DIR",
      localResources.HERMES_DESKTOP_BUNDLED_PLUGINS_DIR,
    ),
    HERMES_OPTIONAL_SKILLS: envDefault("HERMES_OPTIONAL_SKILLS", localResources.HERMES_OPTIONAL_SKILLS),
    HERMES_OPTIONAL_MCPS: envDefault("HERMES_OPTIONAL_MCPS", localResources.HERMES_OPTIONAL_MCPS),
    HERMES_DESKTOP_NODE_BINARY: envDefault(
      "HERMES_DESKTOP_NODE_BINARY",
      localResources.HERMES_DESKTOP_NODE_BINARY,
    ),
    HERMES_DESKTOP_TUI_DIR: envDefault(
      "HERMES_DESKTOP_TUI_DIR",
      localResources.HERMES_DESKTOP_TUI_DIR,
    ),
    // PyO3 chooses the interpreter at build time, while an embedded interpreter
    // does not automatically inherit that venv's site-packages. Reuse the
    // managed dev runtime interpreter and expose its dependency directories so
    // Core imports (orjson, pybase64, etc.) work in `run.py --embedded`.
    ...embeddedPythonEnv,
    // Embedded runtime dev support (docs/embedded-python.md): when requested,
    // point pyo3 at the selected Core checkout's real package. The desktop
    // repository carries no embedded package of its own.
    ...(process.env.HERMES_DESKTOP_EMBEDDED_PYTHON === "1" && embeddedPayload
      ? { HERMES_DESKTOP_EMBEDDED_PAYLOAD: embeddedPayload }
      : {}),
  },
});

child.on("error", (error) => {
  console.error(`Failed to start Tauri dev: ${error.message}`);
  process.exit(1);
});

if (process.env.HERMES_DESKTOP_EMBEDDED_PYTHON === "1") {
  console.log(
    "[tauri-dev-managed] embedded Python mode enabled (HERMES_DESKTOP_EMBEDDED_PYTHON=1); " +
      `payload: ${embeddedPayload ?? "(not found; Rust payload discovery will decide)"}`,
  );
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
