import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function treeContains(dir, predicate) {
  if (!isDirectory(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (treeContains(full, predicate)) return true;
    } else if (predicate(entry.name)) {
      return true;
    }
  }
  return false;
}

function defaultRunCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function requireDirectory(path, label) {
  if (!isDirectory(path)) throw new Error(`${label} directory is missing: ${path}`);
}

export function prepareLocalDevResources({
  sourceRoot,
  nodeExecutable = process.execPath,
  runCommand = defaultRunCommand,
}) {
  const source = resolve(sourceRoot);
  const node = resolve(nodeExecutable);
  const dashboardDist = join(source, "hermes_cli", "web_dist");
  const tuiDir = join(source, "ui-tui");
  const skillsDir = join(source, "skills");
  const pluginsDir = join(source, "plugins");
  const optionalSkillsDir = join(source, "optional-skills");
  const optionalMcpsDir = join(source, "optional-mcps");

  if (!existsSync(node)) throw new Error(`Node executable is missing: ${node}`);

  const assets = [
    {
      workspace: "web",
      valid: () => existsSync(join(dashboardDist, "index.html"))
        && isDirectory(join(dashboardDist, "assets")),
    },
    { workspace: "ui-tui", valid: () => existsSync(join(tuiDir, "dist", "entry.js")) },
  ];
  const missingAssets = assets.filter((asset) => !asset.valid());
  if (missingAssets.length > 0) {
    // Core owns a single workspace lockfile. Installing inside each package
    // ignores its pinned dependency graph and can produce peer conflicts.
    const npm = npmCommand();
    runCommand(npm, [
      "ci", "--workspace=web", "--workspace=ui-tui", "--include-workspace-root=false",
      "--no-audit", "--no-fund",
    ], { cwd: source });
    for (const asset of missingAssets) {
      runCommand(npm, ["run", "build", `--workspace=${asset.workspace}`], { cwd: source });
      if (!asset.valid()) {
        throw new Error(`Core ${asset.workspace} build did not create the expected output`);
      }
    }
  }

  requireDirectory(skillsDir, "Bundled skills");
  if (!treeContains(skillsDir, (name) => name.toLowerCase() === "skill.md")) {
    throw new Error(`Bundled skills contain no SKILL.md files: ${skillsDir}`);
  }
  requireDirectory(pluginsDir, "Bundled plugins");
  if (!treeContains(pluginsDir, (name) => {
    const lower = name.toLowerCase();
    return lower === "plugin.yaml" || lower === "plugin.yml";
  })) {
    throw new Error(`Bundled plugins contain no plugin.yaml files: ${pluginsDir}`);
  }
  requireDirectory(optionalSkillsDir, "Optional skills");
  requireDirectory(optionalMcpsDir, "Optional MCP catalog");

  return {
    HERMES_DESKTOP_DASHBOARD_WEB_DIST_DIR: dashboardDist,
    HERMES_DESKTOP_BUNDLED_SKILLS_DIR: skillsDir,
    HERMES_DESKTOP_BUNDLED_PLUGINS_DIR: pluginsDir,
    HERMES_OPTIONAL_SKILLS: optionalSkillsDir,
    HERMES_OPTIONAL_MCPS: optionalMcpsDir,
    HERMES_DESKTOP_NODE_BINARY: node,
    HERMES_DESKTOP_TUI_DIR: tuiDir,
  };
}
