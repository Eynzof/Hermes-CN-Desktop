#!/usr/bin/env node
/**
 * One-time helper: if dev-local current.json was written into the production
 * runtime tree, archive it so the packaged app can bootstrap bundled runtime.
 *
 * Safe to run multiple times. Does not delete version directories.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function dataDir() {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  if (process.platform === "win32") {
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

const base = join(dataDir(), "cn.org.hermesagent.desktop");
const production = join(base, "runtime");
const dev = join(base, "dev-runtime");
const current = join(production, "current.json");

if (!existsSync(current)) {
  console.log("no production current.json — nothing to migrate");
  process.exit(0);
}

const raw = readFileSync(current, "utf8");
const record = JSON.parse(raw);
if (record.source !== "local-source") {
  console.log(`production current.json source=${record.source}; no migration needed`);
  process.exit(0);
}

mkdirSync(dev, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archive = join(production, `current.json.local-source.${stamp}.bak`);
copyFileSync(current, archive);
renameSync(current, join(dev, "current.json"));
console.log(`moved dev-local pointer to ${join(dev, "current.json")}`);
console.log(`archived production copy at ${archive}`);
console.log('restart packaged app: open -a "Hermes Agent CN Desktop"');