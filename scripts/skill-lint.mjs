#!/usr/bin/env node
// pnpm skills:lint — run the authoritative Rust skills-lint tree linter.
//
// The TS `@hermes/skill-lint` CLI cannot run under plain Node (the package is
// authored in TS with .js specifiers and consumed by bundlers / vitest), so the
// desktop lint script delegates to the real filesystem walker:
// `hermes_agent_cn::skill_lint::tree::lint_tree` exposed through the
// `skills_lint` bin (src/bin/skills_lint.rs). Output is byte-compatible with the
// TS CLI contract (`--source <dir>...`, `--json`, exit 1 on any error finding).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function binaryCandidates() {
  const names =
    process.platform === "win32" ? ["skills_lint.exe"] : ["skills_lint"];
  const dirs = [path.join(repoRoot, "target", "debug"), path.join(repoRoot, "target", "release")];
  const candidates = [];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (existsSync(full)) candidates.push(full);
    }
  }
  return candidates;
}

const built = binaryCandidates()[0];

let result;
if (built) {
  result = spawnSync(built, args, { stdio: "inherit", cwd: repoRoot });
} else {
  // First run: build the tiny bin (the lib is already a desktop dependency).
  result = spawnSync("cargo", ["run", "--quiet", "--bin", "skills_lint", "--", ...args], {
    stdio: "inherit",
    cwd: repoRoot,
  });
}

process.exit(result.status ?? 1);
