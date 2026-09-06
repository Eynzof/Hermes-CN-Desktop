#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipInstall = process.env.HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL === "1";

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

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pnpm tauri:dev[:managed] [--source ../Hermes-CN-Core] [--force]

Installs Hermes-CN-Core into the desktop managed runtime folder, then starts
Tauri dev with external PATH hermes fallback disabled.`);
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

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// Embedded Python mode needs the real pyo3 backend, which lives behind the
// (non-default) `embedded-python` cargo feature. Without it the crate compiles
// the stub backend and bootstrap falls back to the subprocess dashboard.
const devArgs = ["exec", "tauri", "dev"];
if (process.env.HERMES_DESKTOP_EMBEDDED_PYTHON === "1") {
  devArgs.push("--features", "embedded-python");
}
const child = spawn(pnpm, devArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  // Windows: pnpm resolves to pnpm.cmd, and Node cannot spawn .cmd files
  // directly without a shell (spawn EINVAL otherwise).
  shell: process.platform === "win32",
  env: {
    ...process.env,
    // Dev kernels live under dev-runtime/ so they never overwrite the packaged
    // app's production runtime/current.json.
    HERMES_DESKTOP_RUNTIME_ROOT:
      process.env.HERMES_DESKTOP_RUNTIME_ROOT ?? devRuntimeRoot(),
    HERMES_DESKTOP_PRESERVE_LOCAL_RUNTIME:
      process.env.HERMES_DESKTOP_PRESERVE_LOCAL_RUNTIME ?? "1",
    // Default dev mode now exercises the same managed runtime path as the
    // packaged app. Use HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD=1 only when you
    // deliberately want to attach to a separately started dashboard.
    HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT: process.env.HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT ?? "0",
    HERMES_DASHBOARD_TUI: process.env.HERMES_DASHBOARD_TUI ?? "1",
      // Embedded runtime dev support (docs/embedded-python.md): when the
      // embedded interpreter is requested, point the payload at the Core
      // checkout's real `hermes_embedded` package (HERMES_AGENT_CN_SOURCE is
      // set by install-local-runtime.mjs / run.py; the in-repo hermes_backend
      // checkout and the sibling Hermes-CN-Core are fallbacks) so
      // resolve_payload_root finds it without a PyInstaller payload. The
      // desktop repo carries no embedded package of its own.
      ...(process.env.HERMES_DESKTOP_EMBEDDED_PYTHON === "1"
        ? {
            HERMES_DESKTOP_EMBEDDED_PAYLOAD:
              process.env.HERMES_DESKTOP_EMBEDDED_PAYLOAD ??
              [
                process.env.HERMES_AGENT_CN_SOURCE &&
                  resolve(process.env.HERMES_AGENT_CN_SOURCE, "hermes_embedded"),
                resolve(repoRoot, "hermes_backend", "hermes_embedded"),
                resolve(repoRoot, "..", "Hermes-CN-Core", "hermes_embedded"),
              ].find(Boolean),
          }
        : {}),
  },
});

if (process.env.HERMES_DESKTOP_EMBEDDED_PYTHON === "1") {
  console.log(
    "[tauri-dev-managed] embedded Python mode enabled (HERMES_DESKTOP_EMBEDDED_PYTHON=1); " +
      `payload: ${process.env.HERMES_DESKTOP_EMBEDDED_PAYLOAD ?? "(Core checkout hermes_embedded)"}`,
  );
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
