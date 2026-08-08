#!/usr/bin/env node
// Dev-source backend hot update (track: local-source dev runtime only).
//
// Pulls the latest Hermes-CN-Core source from the configured remote, re-installs
// the Python environment into the desktop dev-runtime, then the caller
// (hot_update_backend command) restarts the managed dashboard so the change
// goes live without touching the desktop shell or its bundled web dist.
//
// Usage:
//   node scripts/hot-update-backend.mjs [--source D:/hermes-agent-cn] \
//       [--skip-git] [--skip-frontend-deps] [--build-frontend] [--dry-run]
//
// Safety (per plan): shell:false for every spawn; abort on a dirty tree; never
// auto-stash or reset; abort on a non-fast-forward pull.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function log(message) {
  console.log(`[hot-update] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { shell: false, stdio: "inherit", ...options });
  if (result.error) {
    throw new Error(`spawn ${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return result;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { shell: false, encoding: "utf8", ...options });
  if (result.error) {
    throw new Error(`spawn ${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return (result.stdout ?? "").trim();
}

function defaultSourceRoot() {
  const preferred = resolve(repoRoot, "../Hermes-CN-Core");
  if (existsSync(preferred)) return preferred;
  return resolve(repoRoot, "../hermes-agent-cn");
}

const dryRun = hasFlag("--dry-run");
const skipGit = hasFlag("--skip-git");
const skipFrontendDeps = hasFlag("--skip-frontend-deps");
const buildFrontend = hasFlag("--build-frontend");
const sourceArg =
  argValue("--source") ?? process.env.HERMES_AGENT_CN_SOURCE ?? defaultSourceRoot();
const sourceRoot = resolve(repoRoot, sourceArg);

// 1. Resolve + validate the source checkout.
if (!existsSync(resolve(sourceRoot, "pyproject.toml"))) {
  console.error(
    `[hot-update] source is not a Hermes-CN-Core checkout (no pyproject.toml): ${sourceRoot}`,
  );
  process.exit(2);
}
log(`source: ${sourceRoot}`);

// 2. Git pull with a dirty-tree guard (unless --skip-git).
let commit = null;
if (!skipGit) {
  log("[git] checking working tree is clean …");
  const status = spawnSync("git", ["-C", sourceRoot, "status", "--porcelain=v1"], {
    shell: false,
    encoding: "utf8",
  });
  if (status.error) throw new Error(`git status failed: ${status.error.message}`);
  if (status.status !== 0) throw new Error(`git status exited with ${status.status}`);
  if ((status.stdout ?? "").trim().length > 0) {
    console.error(
      `[hot-update] source working tree is dirty — aborting. Commit or stash first:\n${status.stdout}`,
    );
    process.exit(3);
  }
  log("[git] pulling origin (fast-forward only) …");
  const before = capture("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
  if (dryRun) {
    log("[dry-run] would run: git pull --ff-only");
  } else {
    run("git", ["-C", sourceRoot, "pull", "--ff-only"]);
  }
  commit = capture("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
  if (commit !== before) log(`[git] ${before.slice(0, 12)} -> ${commit.slice(0, 12)}`);
  else log(`[git] already up to date (${commit.slice(0, 12)})`);
} else {
  log("[git] skipping git pull (--skip-git)");
  try {
    commit = capture("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
  } catch {
    commit = null;
  }
}

// 3. Optional frontend steps (opt-in; skipped by default so a running Vite dev
//    server is not disturbed).
if (!skipFrontendDeps && buildFrontend) {
  log("[frontend] pnpm install …");
  run("pnpm", ["install"], { cwd: repoRoot });
}
if (buildFrontend) {
  log("[frontend] pnpm web:build:desktop …");
  run("pnpm", ["web:build:desktop"], { cwd: repoRoot });
}

// 4. Rebuild the backend environment into the dev-runtime.
log("[install] installing local runtime into dev-runtime …");
const installArgs = ["scripts/install-local-runtime.mjs", "--source", sourceRoot, "--force"];
if (dryRun) {
  log(`[dry-run] would run: node ${installArgs.join(" ")}`);
} else {
  run("node", installArgs, { cwd: repoRoot });
}

log(`commit: ${commit ?? "unknown"}`);
console.log("HOT_UPDATE_DONE");
