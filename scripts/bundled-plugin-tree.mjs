import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walkFiles(dir, visit) {
  if (!isDirectory(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, visit);
    } else {
      visit(full, entry.name);
    }
  }
}

export function containsPluginManifest(path) {
  let found = false;
  walkFiles(path, (_full, name) => {
    if (/^plugin\.ya?ml$/iu.test(name)) {
      found = true;
    }
  });
  return found;
}

export function validateBundledPluginTree(path) {
  if (!isDirectory(path)) {
    throw new Error(`bundled plugins source is missing: ${path}`);
  }
  if (!containsPluginManifest(path)) {
    throw new Error(`bundled plugins source is missing plugin.yaml files: ${path}`);
  }

  const missingApis = [];
  walkFiles(path, (full, name) => {
    if (name.toLowerCase() !== "manifest.json" || basename(dirname(full)) !== "dashboard") {
      return;
    }
    const manifest = JSON.parse(readFileSync(full, "utf8"));
    const api = typeof manifest.api === "string" ? manifest.api.trim() : "";
    if (api && !existsSync(join(dirname(full), api))) {
      missingApis.push(join(dirname(full), api));
    }
  });

  if (missingApis.length > 0) {
    throw new Error(
      `bundled dashboard plugins declare missing api files: ${missingApis.slice(0, 5).join(", ")}`,
    );
  }
}
