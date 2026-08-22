import type { ContextFile, ContextFileSource } from "./types.js";
import { basename, dirname, join, normalizePath, normalizeSeparators } from "./path.js";

/**
 * Reader abstraction so `loadContextFiles` can be unit-tested without a
 * Tauri runtime.  The default implementation calls the Rust `read_context_files`
 * command, which returns content for files that exist and `null` for missing
 * paths.
 */
export interface ContextFileReader {
  readFiles(paths: string[]): Promise<Array<{ path: string; content: string | null }>>;
}

export interface LoadContextFilesOptions {
  /** Override the default Tauri file reader (used by tests). */
  reader?: ContextFileReader;
  /** Explicit SOUL.md path.  When omitted, `SOUL.md` is searched from `cwd`. */
  soulPath?: string;
}

const defaultReader: ContextFileReader = {
  async readFiles(paths) {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ results: Array<{ path: string; content: string | null }> }>(
      "read_context_files",
      { input: { paths } },
    );
    return result.results;
  },
};

interface Candidate {
  path: string;
  source: ContextFileSource;
  provenance: string;
}

/**
 * Discover and read context files relative to `cwd`.
 *
 * The loader walks from `cwd` up to the filesystem root and collects candidates
 * for `.hermes.md` / `HERMES.md`, `AGENTS.md` / `agents.md`, `CLAUDE.md` /
 * `claude.md`, `.cursorrules`, and `SOUL.md`.  Only files that the reader reports
 * as existing are returned; ordering follows the walk (cwd-first).
 *
 * Callers typically pass the result through {@link resolveContextFiles} to apply
 * the priority rules and chain ordering.
 */
export async function loadContextFiles(
  cwd: string,
  options: LoadContextFilesOptions = {},
): Promise<ContextFile[]> {
  const reader = options.reader ?? defaultReader;
  const candidates = collectCandidates(cwd, options.soulPath);
  const results = await reader.readFiles(candidates.map((c) => c.path));

  const contentByPath = new Map<string, string | null>();
  for (const entry of results) {
    // Keep case when mapping reader results back to requested paths; case-insensitive
    // de-duplication happens later in the resolver.
    contentByPath.set(normalizeSeparators(entry.path), entry.content);
  }

  return materializeCandidates(candidates, contentByPath);
}

function collectCandidates(cwd: string, soulPath?: string): Candidate[] {
  const candidates: Candidate[] = [];

  // AGENTS.md chain: every directory from cwd up to the root gets a chance to
  // contribute either AGENTS.md or agents.md (resolved later by priority).
  let current = cwd;
  const visited = new Set<string>();
  for (let depth = 0; depth < 32 && current && !visited.has(current); depth++) {
    visited.add(current);
    candidates.push(
      { path: join(current, "AGENTS.md"), source: "agents", provenance: `${current}/AGENTS.md` },
      { path: join(current, "agents.md"), source: "agents", provenance: `${current}/agents.md` },
    );
    const parent = dirname(current);
    if (parent === current || parent === "") break;
    current = parent;
  }

  // Cwd-only project-context files.
  candidates.push(
    { path: join(cwd, ".hermes.md"), source: "hermes", provenance: ".hermes.md" },
    { path: join(cwd, "HERMES.md"), source: "hermes", provenance: "HERMES.md" },
    { path: join(cwd, "CLAUDE.md"), source: "claude", provenance: "CLAUDE.md" },
    { path: join(cwd, "claude.md"), source: "claude", provenance: "claude.md" },
    { path: join(cwd, ".cursorrules"), source: "cursor", provenance: ".cursorrules" },
  );

  // SOUL.md.
  const soul = soulPath ?? join(cwd, "SOUL.md");
  candidates.push({ path: soul, source: "soul", provenance: basename(soul) });

  return candidates;
}

function materializeCandidates(
  candidates: Candidate[],
  contentByPath: Map<string, string | null>,
): ContextFile[] {
  const files: ContextFile[] = [];
  const agentsChosenDir = new Set<string>();

  for (const candidate of candidates) {
    const content = contentByPath.get(normalizeSeparators(candidate.path));
    if (content == null) continue;

    if (candidate.source === "agents") {
      // Within a single directory, AGENTS.md beats agents.md.  Candidates are
      // emitted in cwd-first order with the uppercase name first, so the first
      // existing file wins.
      const dirKey = normalizePath(dirname(candidate.path));
      if (agentsChosenDir.has(dirKey)) continue;
      agentsChosenDir.add(dirKey);
      files.push({
        path: candidate.path,
        source: candidate.source,
        content,
        provenance: candidate.provenance,
      });
      continue;
    }

    files.push({
      path: candidate.path,
      source: candidate.source,
      content,
      provenance: candidate.provenance,
    });
  }

  return files;
}
