import type { ContextFile } from "./types.js";
import { normalizePath } from "./path.js";

export type ContextFileOrder = "root-to-cwd" | "cwd-to-root";

export interface ResolveContextFilesOptions {
  /** Ordering for the AGENTS.md chain. */
  order?: ContextFileOrder;
}

/**
 * Resolve discovered context files into the set that should be injected.
 *
 * Rules:
 * 1. De-duplicate by normalized path (keeps the first occurrence).
 * 2. `SOUL.md` (`source === "soul"`) is always kept.
 * 3. Only one project-context source is kept per session, by priority:
 *    `.hermes.md` > `AGENTS.md` chain > `CLAUDE.md` > `.cursorrules`.
 * 4. The `AGENTS.md` chain is sorted by the requested `order` (depth).
 */
export function resolveContextFiles(
  files: ContextFile[],
  options: ResolveContextFilesOptions = {},
): ContextFile[] {
  const order = options.order ?? "root-to-cwd";

  // De-duplicate by normalized path, keeping the first occurrence.
  const seen = new Set<string>();
  const deduped = files.filter((file) => {
    const key = normalizePath(file.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // SOUL.md is independent and always included.
  const soul = deduped.filter((f) => f.source === "soul");

  // Pick the highest-priority project-context source that has at least one file.
  const projectSources: Array<ContextFile["source"]> = ["hermes", "agents", "claude", "cursor"];
  let selected: ContextFile[] = [];
  for (const source of projectSources) {
    const matches = deduped.filter((f) => f.source === source);
    if (matches.length > 0) {
      selected = matches;
      break;
    }
  }

  // Order AGENTS.md chain by directory depth.
  if (selected.some((f) => f.source === "agents")) {
    selected = sortByDepth(selected, order);
  }

  return [...soul, ...selected];
}

function sortByDepth(files: ContextFile[], order: ContextFileOrder): ContextFile[] {
  return [...files].sort((a, b) => {
    const depthA = a.path.split(/[\\/]/).filter(Boolean).length;
    const depthB = b.path.split(/[\\/]/).filter(Boolean).length;
    return order === "root-to-cwd" ? depthA - depthB : depthB - depthA;
  });
}
