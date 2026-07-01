#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pnpmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && !/[\\/]pnpm\.cmd$/i.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args], shell: false };
  }
  return {
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args,
    shell: process.platform === "win32",
  };
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pnpm tauri:dev:external

Deprecated compatibility alias. The desktop is locked to its managed runtime,
so this now starts the same managed dev path as pnpm tauri:dev.`);
  process.exit(0);
}

const pnpm = pnpmInvocation(["exec", "tauri", "dev"]);
const child = spawn(pnpm.command, pnpm.args, {
  cwd: repoRoot,
  stdio: "inherit",
  shell: pnpm.shell,
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
