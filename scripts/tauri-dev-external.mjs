#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pnpm tauri:dev:external

Deprecated compatibility alias. The desktop is locked to its managed runtime,
so this now starts the same managed dev path as pnpm tauri:dev.`);
  process.exit(0);
}

// Honor embedded mode when explicitly requested (the real pyo3 backend lives
// behind the non-default `embedded-python` cargo feature).
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
    HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT: "0",
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
