import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareLocalDevResources } from "./prepare-local-dev-resources.mjs";

function write(path, content = "fixture") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function seedCatalogs(sourceRoot) {
  write(join(sourceRoot, "skills", "demo", "SKILL.md"), "# demo");
  write(join(sourceRoot, "plugins", "demo", "plugin.yaml"), "name: demo\n");
  write(join(sourceRoot, "plugins", "demo", "__init__.py"), "");
  write(join(sourceRoot, "optional-skills", "demo", "SKILL.md"), "# optional");
  write(join(sourceRoot, "optional-mcps", "demo", "manifest.yaml"), "name: demo\n");
}

test("returns every resource path without rebuilding complete Core assets", () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-local-resources-"));
  try {
    const sourceRoot = join(root, "core");
    write(join(sourceRoot, "hermes_cli", "web_dist", "index.html"), "<main />");
    write(join(sourceRoot, "hermes_cli", "web_dist", "assets", "app.js"), "// app");
    write(join(sourceRoot, "ui-tui", "dist", "entry.js"), "// tui");
    seedCatalogs(sourceRoot);

    const calls = [];
    const env = prepareLocalDevResources({
      sourceRoot,
      nodeExecutable: process.execPath,
      runCommand: (...args) => calls.push(args),
    });

    assert.equal(calls.length, 0);
    assert.equal(env.HERMES_DESKTOP_DASHBOARD_WEB_DIST_DIR, join(sourceRoot, "hermes_cli", "web_dist"));
    assert.equal(env.HERMES_DESKTOP_BUNDLED_SKILLS_DIR, join(sourceRoot, "skills"));
    assert.equal(env.HERMES_DESKTOP_BUNDLED_PLUGINS_DIR, join(sourceRoot, "plugins"));
    assert.equal(env.HERMES_OPTIONAL_SKILLS, join(sourceRoot, "optional-skills"));
    assert.equal(env.HERMES_OPTIONAL_MCPS, join(sourceRoot, "optional-mcps"));
    assert.equal(env.HERMES_DESKTOP_NODE_BINARY, process.execPath);
    assert.equal(env.HERMES_DESKTOP_TUI_DIR, join(sourceRoot, "ui-tui"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installs dependencies and builds missing Dashboard and TUI outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-local-resources-build-"));
  try {
    const sourceRoot = join(root, "core");
    const webDir = join(sourceRoot, "web");
    const tuiDir = join(sourceRoot, "ui-tui");
    write(join(webDir, "package.json"), "{}");
    write(join(tuiDir, "package.json"), "{}");
    seedCatalogs(sourceRoot);

    const calls = [];
    const runCommand = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (args[0] === "ci") {
        mkdirSync(join(options.cwd, "node_modules"), { recursive: true });
      } else if (args.includes("--workspace=web")) {
        write(join(sourceRoot, "hermes_cli", "web_dist", "index.html"), "<main />");
        write(join(sourceRoot, "hermes_cli", "web_dist", "assets", "app.js"), "// app");
      } else if (args.includes("--workspace=ui-tui")) {
        write(join(tuiDir, "dist", "entry.js"), "// tui");
      }
    };

    prepareLocalDevResources({ sourceRoot, nodeExecutable: process.execPath, runCommand });

    assert.deepEqual(
      calls.map(({ args, cwd }) => [args.join(" "), cwd]),
      [
        ["ci --workspace=web --workspace=ui-tui --include-workspace-root=false --no-audit --no-fund", sourceRoot],
        ["run build --workspace=web", sourceRoot],
        ["run build --workspace=ui-tui", sourceRoot],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
