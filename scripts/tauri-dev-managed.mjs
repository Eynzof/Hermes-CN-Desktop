#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipInstall = process.env.HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL === "1";

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
