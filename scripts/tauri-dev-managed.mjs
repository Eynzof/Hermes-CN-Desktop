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
const child = spawn(pnpm, ["exec", "tauri", "dev"], {
  cwd: repoRoot,
  stdio: "inherit",
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
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
