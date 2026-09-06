#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolveD1DatabaseIdentifier } from "./d1-database.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`缺少 --${name}`);
  return process.argv[index + 1];
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout;
}

const database = option("database");
const databaseId = resolveD1DatabaseIdentifier(database, run);
const apply = process.argv.includes("--apply");
const releases = JSON.parse(
  run("gh", ["release", "list", "--limit", "100", "--json", "tagName,publishedAt,isPrerelease"]),
)
  .filter(
    (release) =>
      release.isPrerelease && /-(?:nightly|prototype\.nightly)\.\d{8}\.\d+$/.test(release.tagName),
  )
  .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

const d1 = JSON.parse(
  run("pnpm", [
    "exec", "wrangler", "d1", "execute", databaseId, "--remote", "--json",
    "--command", "SELECT DISTINCT github_release_tag FROM releases WHERE github_release_tag != '';",
  ]),
);
const referenced = new Set(
  d1.flatMap((batch) => batch.results || []).map((row) => row.github_release_tag),
);
const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
const removable = releases.filter(
  (release, index) => index >= 7 && Date.parse(release.publishedAt) < cutoff && !referenced.has(release.tagName),
);
for (const release of removable) {
  process.stdout.write(`${apply ? "delete" : "would-delete"} ${release.tagName}\n`);
  if (apply) run("gh", ["release", "delete", release.tagName, "--cleanup-tag", "--yes"]);
}
