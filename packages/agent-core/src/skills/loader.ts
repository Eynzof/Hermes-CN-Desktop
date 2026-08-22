/**
 * Skill pack loader.
 *
 * Parses SKILL.md frontmatter, loads skill packs from an abstract filesystem
 * adapter, and materializes bundled skill packs from in-memory descriptors.
 * This module is intentionally free of direct disk/HTTP access so it can run
 * in the Tauri webview with Rust-provided I/O.
 */

import type {
  ParsedSkillFile,
  Skill,
  SkillBundle,
  SkillCommand,
  SkillLevel,
  SkillMetadata,
  SkillReference,
} from "./types.js";

/** Abstract filesystem used by the disk loader. */
export interface SkillFs {
  /** Read a text file. Throws/returns undefined when missing. */
  readFile(path: string): Promise<string | undefined>;
  /** List file/directory names directly under `path`. */
  listDir(path: string): Promise<string[]>;
  /** Returns true when `path` exists. */
  exists(path: string): Promise<boolean>;
  /** Join path segments using the runtime's path separator. */
  join(...parts: string[]): string;
}

export interface LoadSkillPackOptions {
  fs: SkillFs;
  /** Root directory containing skill subdirectories. */
  root: string;
  /** Origin classification for loaded skills. */
  origin?: Skill["origin"];
}

export interface LoadSkillFromContentOptions {
  id: string;
  sourcePath?: string;
  origin?: Skill["origin"];
  content: string;
  /** Optional index of linked files already known to the caller. */
  linkedFiles?: {
    references?: SkillReference[];
    templates?: SkillReference[];
    assets?: SkillReference[];
    scripts?: SkillReference[];
  };
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Minimal YAML frontmatter parser covering the fields used by Hermes skills:
 * name, description, category, platforms, prerequisites, tags.
 *
 * Keeps the package dependency-free; full YAML parity can be swapped in later.
 */
export function parseFrontmatter(text: string): ParsedSkillFile {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return { metadata: { name: "", description: "" }, body: text };
  }

  const raw = match[1];
  const body = text.slice(match[0].length);
  const metadata: Record<string, unknown> = {};

  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value: unknown = line.slice(idx + 1).trim();

    // Remove surrounding quotes.
    if (typeof value === "string" && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    // Inline list: `tags: [a, b, c]`
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // Multi-line list:
    //   platforms:
    //     - linux
    //     - darwin
    if (value === "") {
      // Look ahead not supported here; rely on inline form for simplicity.
      value = [];
    }

    metadata[key] = value;
  }

  return {
    metadata: normalizeMetadata(metadata),
    body,
  };
}

function normalizeMetadata(raw: Record<string, unknown>): SkillMetadata {
  const name = String(raw.name ?? "").trim();
  const description = String(raw.description ?? "").trim();
  const category = raw.category ? String(raw.category).trim() : undefined;

  function toStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return undefined;
  }

  return {
    name,
    description,
    category,
    platforms: toStringArray(raw.platforms),
    prerequisites: toStringArray(raw.prerequisites),
    tags: toStringArray(raw.tags),
  };
}

/** Validate and truncate skill metadata. */
export function validateSkillMetadata(metadata: SkillMetadata): { metadata: SkillMetadata; warnings: string[] } {
  const warnings: string[] = [];
  let name = metadata.name;
  let description = metadata.description;

  if (!name) warnings.push("Skill metadata is missing 'name'.");
  if (!description) warnings.push("Skill metadata is missing 'description'.");
  if (name.length > MAX_NAME_LENGTH) {
    warnings.push(`Skill name exceeds ${MAX_NAME_LENGTH} characters and will be truncated.`);
    name = name.slice(0, MAX_NAME_LENGTH);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    warnings.push(`Skill description exceeds ${MAX_DESCRIPTION_LENGTH} characters and will be truncated.`);
    description = description.slice(0, MAX_DESCRIPTION_LENGTH);
  }

  return {
    metadata: { ...metadata, name, description },
    warnings,
  };
}

/** Parse raw SKILL.md content into a Skill at L1. */
export function loadSkillFromContent(options: LoadSkillFromContentOptions): Skill {
  const { id, content, origin = "user", sourcePath, linkedFiles } = options;
  const { metadata, body } = parseFrontmatter(content);
  const { metadata: validated } = validateSkillMetadata(metadata);

  return {
    id,
    name: validated.name || id,
    description: validated.description,
    category: validated.category || "general",
    level: "L1",
    origin,
    metadata: validated,
    content: body.trim(),
    references: linkedFiles?.references ?? [],
    templates: linkedFiles?.templates ?? [],
    assets: linkedFiles?.assets ?? [],
    scripts: linkedFiles?.scripts ?? [],
    commands: deriveCommands(validated),
    sourcePath,
  };
}

/** Derive slash-style commands from skill metadata when present. */
function deriveCommands(metadata: SkillMetadata): SkillCommand[] {
  const commands: SkillCommand[] = [];
  const commandsRaw = metadata.commands;
  if (Array.isArray(commandsRaw)) {
    for (const item of commandsRaw) {
      if (typeof item === "object" && item && "name" in item) {
        const cmd = item as Record<string, unknown>;
        commands.push({
          name: String(cmd.name),
          description: typeof cmd.description === "string" ? cmd.description : "",
          argsHint: typeof cmd.argsHint === "string" ? cmd.argsHint : undefined,
        });
      }
    }
  }
  return commands;
}

/**
 * Recursively discover `<root>/<category>/<skill>/SKILL.md` and legacy
 * `<root>/<skill>.md` files using the provided `SkillFs` adapter.
 */
export async function loadSkillPack(options: LoadSkillPackOptions): Promise<Skill[]> {
  const { fs, root, origin = "user" } = options;
  const skills: Skill[] = [];
  const topEntries = await fs.listDir(root).catch(() => [] as string[]);

  for (const entry of topEntries) {
    const topPath = fs.join(root, entry);

    // Legacy flat file: `<root>/<skill>.md`
    if (entry.toLowerCase().endsWith(".md") && entry.toLowerCase() !== "readme.md") {
      const content = await fs.readFile(topPath);
      if (content !== undefined) {
        const id = entry.slice(0, -3);
        skills.push(
          loadSkillFromContent({
            id,
            sourcePath: topPath,
            origin,
            content,
          }),
        );
      }
      continue;
    }

    // Category directory containing skill subdirectories.
    const category = entry;
    const categoryEntries = await fs.listDir(topPath).catch(() => [] as string[]);

    for (const skillDir of categoryEntries) {
      const skillPath = fs.join(topPath, skillDir);
      const skillFile = fs.join(skillPath, "SKILL.md");
      const content = await fs.readFile(skillFile);
      if (content === undefined) continue;

      const linkedFiles = await indexLinkedFiles(fs, skillPath);
      skills.push(
        loadSkillFromContent({
          id: skillDir,
          sourcePath: skillFile,
          origin,
          content,
          linkedFiles,
        }),
      );
    }
  }

  return skills;
}

async function indexLinkedFiles(fs: SkillFs, skillPath: string): Promise<NonNullable<LoadSkillFromContentOptions["linkedFiles"]>> {
  const refs: Record<string, SkillReference[]> = {};
  const dirs = ["references", "templates", "assets", "scripts"] as const;

  for (const dir of dirs) {
    const dirPath = fs.join(skillPath, dir);
    const entries = await fs.listDir(dirPath).catch(() => [] as string[]);
    refs[dir] = [];
    for (const name of entries) {
      refs[dir].push({
        name,
        path: `${dir}/${name}`,
      });
    }
  }

  return {
    references: refs.references,
    templates: refs.templates,
    assets: refs.assets,
    scripts: refs.scripts,
  };
}

/** Load a bundled skill pack from an in-memory descriptor. */
export function loadBundledSkills(bundle: SkillBundle): Skill[] {
  return bundle.skills.map((skill) => ({
    ...skill,
    origin: bundle.origin ?? skill.origin ?? "bundled",
  }));
}

/** Load a single linked file into the skill, returning an L2 reference. */
export async function loadSkillReference(
  fs: SkillFs,
  skill: Skill,
  refPath: string,
): Promise<SkillReference | undefined> {
  if (!skill.sourcePath) return undefined;
  const skillDir = skill.sourcePath.replace(/[\\/]SKILL\.md$/i, "");
  const parts = refPath.split("/").filter(Boolean);
  const fullPath = fs.join(skillDir, ...parts);
  const content = await fs.readFile(fullPath);
  if (content === undefined) return undefined;
  return { name: parts[parts.length - 1] || refPath, path: refPath, content };
}

/** True when `level` is at least as detailed as `target`. */
export function skillLevelGte(level: SkillLevel, target: SkillLevel): boolean {
  const order: Record<SkillLevel, number> = { L0: 0, L1: 1, L2: 2 };
  return order[level] >= order[target];
}
