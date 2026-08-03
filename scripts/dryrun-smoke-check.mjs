#!/usr/bin/env node
// Dry-run reproduction of the desktop's runtime smoke check
// (src/process/runtime.rs::smoke_check_runtime -> wait_for_smoke_child).
//
// The Rust code spawns:
//   <runtime> dashboard --help
// with cwd = the executable's parent dir, stdout/stderr nulled, env guards
// HERMES_DISABLE_LAZY_INSTALLS=1 and HERMES_DASHBOARD_PREWARM_AGENT=0,
// and kills the child if it does not exit within SMOKE_TIMEOUT (60s),
// producing the error:
//   Smoke check failed: Smoke check timed out after 60s
//
// This script reproduces that exact behavior against a runtime executable so
// the version-specific regression can be verified without launching Tauri.
//
// Usage:
//   node scripts/dryrun-smoke-check.mjs [path-to-runtime-exe]
// Env:
//   SMOKE_TIMEOUT_SECS  override the cap (default 180, matching the Rust
//                       SMOKE_TIMEOUT after the Python 3.14 runtime fix)
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const TIMEOUT_SECS = Number(process.env.SMOKE_TIMEOUT_SECS ?? 180);
const RUNS = Number(process.env.RUNS ?? 3);

const candidates = [
  process.argv[2],
  process.env.RUNTIME_EXE,
  // official shipped runtime (if present)
  resolve("..", "Hermes-CN-Core", "official-runtime-cn7", "hermes-agent-cn-runtime-win32-x64.exe"),
  // locally built frozen runtime (if present)
  resolve("..", "Hermes-CN-Core", "dist", "hermes-agent-cn-runtime-win32-x64", "hermes-agent-cn-runtime-win32-x64.exe"),
].filter(Boolean);

const exe = candidates.find((c) => existsSync(c));
if (!exe) {
  console.error("No runtime executable found. Pass one as argv[2] or set RUNTIME_EXE.");
  process.exit(2);
}
const workdir = dirname(exe);
console.log(`exe     : ${exe}`);
console.log(`size    : ${statSync(exe).size} bytes`);
console.log(`cwd     : ${workdir}`);
console.log(`timeout : ${TIMEOUT_SECS}s (Rust SMOKE_TIMEOUT)`);
console.log("");

function runOnce() {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(exe, ["dashboard", "--help"], {
      cwd: workdir,
      stdio: "ignore", // stdout/stderr/stdin nulled, like Rust Stdio::null()
      env: {
        ...process.env,
        HERMES_DISABLE_LAZY_INSTALLS: "1",
        HERMES_DASHBOARD_PREWARM_AGENT: "0",
      },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ timedOut: true, elapsedMs: Date.now() - started });
    }, TIMEOUT_SECS * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ error: err.message, elapsedMs: Date.now() - started });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ timedOut: false, code, elapsedMs: Date.now() - started });
    });
  });
}

let failed = false;
for (let i = 0; i < RUNS; i++) {
  const r = await runOnce();
  if (r.timedOut) {
    failed = true;
    console.log(
      `run${i}: TIMED OUT after ${(r.elapsedMs / 1000).toFixed(2)}s ` +
        `-> "Smoke check failed: Smoke check timed out after ${TIMEOUT_SECS}s"`
    );
  } else if (r.error) {
    failed = true;
    console.log(`run${i}: SPAWN ERROR after ${(r.elapsedMs / 1000).toFixed(2)}s: ${r.error}`);
  } else if (r.code !== 0) {
    failed = true;
    console.log(`run${i}: EXIT=${r.code} (non-zero) after ${(r.elapsedMs / 1000).toFixed(2)}s`);
  } else {
    console.log(`run${i}: OK exit=0 in ${(r.elapsedMs / 1000).toFixed(2)}s`);
  }
}

console.log("");
if (failed) {
  console.log("RESULT: BUG TRIGGERED — the smoke check would fail on this runtime.");
  process.exit(1);
} else {
  console.log(`RESULT: no timeout — smoke check passes within the ${TIMEOUT_SECS}s budget on this machine.`);
  process.exit(0);
}
