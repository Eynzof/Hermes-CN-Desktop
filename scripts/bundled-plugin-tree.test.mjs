import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  containsPluginManifest,
  validateBundledPluginTree,
} from "./bundled-plugin-tree.mjs";

function withPluginTree(run) {
  const root = mkdtempSync(join(tmpdir(), "hermes-bundled-plugins-test-"));
  try {
    const plugin = join(root, "kanban");
    const dashboard = join(plugin, "dashboard");
    mkdirSync(dashboard, { recursive: true });
    writeFileSync(join(plugin, "plugin.yaml"), "name: kanban\n");
    writeFileSync(
      join(dashboard, "manifest.json"),
      JSON.stringify({ name: "kanban", api: "plugin_api.py" }),
    );
    run({ root, dashboard });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts a dashboard plugin with its declared API file", () => {
  withPluginTree(({ root, dashboard }) => {
    writeFileSync(join(dashboard, "plugin_api.py"), "router = None\n");

    assert.equal(containsPluginManifest(root), true);
    assert.doesNotThrow(() => validateBundledPluginTree(root));
  });
});

test("rejects a dashboard plugin whose declared API file is absent", () => {
  withPluginTree(({ root }) => {
    assert.throws(
      () => validateBundledPluginTree(root),
      /bundled dashboard plugins declare missing api files/u,
    );
  });
});
