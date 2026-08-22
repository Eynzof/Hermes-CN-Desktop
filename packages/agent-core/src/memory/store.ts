/**
 * Bounded in-process memory store.
 *
 * Keeps two scopes (`memory` and `user`) of curated, §-delimited durable
 * entries. Mutations are bounded by a code-point character budget and support
 * exact-duplicate suppression, substring search, and importance-based pruning.
 */

import type {
  BoundedMemoryStoreOptions,
  MemoryEntry,
  MemoryFs,
  MemoryMutationResult,
  MemoryScope,
  MemorySearchResult,
  MemoryUsage,
} from "./types.js";

const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;
const ENTRY_DELIMITER = "\n§\n";

/** Count Unicode code points (matches Python `len()` and Rust `chars().count()`). */
export function charCount(value: string): number {
  return [...value].length;
}

/** Parse §-delimited entries, skipping blanks and trimming whitespace. */
export function parseMemoryEntries(raw: string): MemoryEntry[] {
  if (raw.trim().length === 0) return [];
  return raw
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((content) => ({ content, importance: 0.5 }));
}

/** Serialize entries back to the §-delimited file format. */
export function serializeEntries(entries: MemoryEntry[]): string {
  return entries
    .map((entry) => entry.content.trim())
    .filter((content) => content.length > 0)
    .join(ENTRY_DELIMITER);
}

/** Compute a simple importance heuristic: longer, denser entries score higher. */
export function defaultImportance(content: string): number {
  const lengthScore = Math.min(content.length / 200, 0.5);
  const lineDensity = content.split("\n").length / Math.max(content.length / 80, 1);
  return Math.min(0.9, 0.3 + lengthScore + lineDensity * 0.2);
}

export class BoundedMemoryStore {
  private readonly limits: Record<MemoryScope, number>;
  private readonly fs?: MemoryFs;
  private readonly getPath?: (scope: MemoryScope) => string;
  private readonly entries: Record<MemoryScope, MemoryEntry[]> = {
    memory: [],
    user: [],
  };

  constructor(options: BoundedMemoryStoreOptions = {}) {
    this.limits = {
      memory: Math.max(1, options.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT),
      user: Math.max(1, options.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT),
    };
    this.fs = options.fs;
    this.getPath = options.getPath;
  }

  /** Load a scope from a raw file string. */
  load(scope: MemoryScope, raw: string): void {
    this.entries[scope] = parseMemoryEntries(raw);
  }

  /** Replace the whole scope with explicit entries and persist if backed by FS. */
  async setEntries(scope: MemoryScope, entries: MemoryEntry[]): Promise<MemoryMutationResult> {
    const serialized = serializeEntries(entries);
    const used = charCount(serialized);
    if (used > this.limits[scope]) {
      return {
        success: false,
        message: `Over budget (${used} / ${this.limits[scope]} chars).`,
        usage: this.usage(scope),
        currentEntries: this.entries[scope],
      };
    }
    this.entries[scope] = entries;
    await this.persist(scope);
    return {
      success: true,
      message: `Set ${entries.length} ${scope} entr${entries.length === 1 ? "y" : "ies"}.`,
      usage: this.usage(scope),
    };
  }

  /** Append a new entry, suppressing exact duplicates and enforcing the budget. */
  async add(scope: MemoryScope, content: string, importance?: number): Promise<MemoryMutationResult> {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return { success: false, message: "Content cannot be empty.", usage: this.usage(scope) };
    }
    if (this.entries[scope].some((entry) => entry.content === trimmed)) {
      return { success: false, message: "Exact duplicate; not added.", usage: this.usage(scope) };
    }

    const candidate: MemoryEntry = {
      content: trimmed,
      importance: importance ?? defaultImportance(trimmed),
    };
    const next = [...this.entries[scope], candidate];
    const serialized = serializeEntries(next);
    const used = charCount(serialized);
    if (used > this.limits[scope]) {
      return {
        success: false,
        message: `Over budget (${used} / ${this.limits[scope]} chars).`,
        usage: this.usage(scope),
        currentEntries: this.entries[scope],
      };
    }

    this.entries[scope] = next;
    await this.persist(scope);
    return {
      success: true,
      message: `Added ${scope} entry.`,
      usage: this.usage(scope),
    };
  }

  /** Substring search across entries in a scope. */
  search(scope: MemoryScope, query: string): MemorySearchResult {
    const q = query.trim().toLowerCase();
    return {
      entries: this.entries[scope].filter((entry) => entry.content.toLowerCase().includes(q)),
      usage: this.usage(scope),
    };
  }

  /**
   * Replace the first occurrence of `oldText` inside the first matching entry
   * with `newContent`.
   */
  async update(scope: MemoryScope, oldText: string, newContent: string): Promise<MemoryMutationResult> {
    const needle = oldText.trim();
    const replacement = newContent.trim();
    if (needle.length === 0) {
      return { success: false, message: "old_text cannot be empty.", usage: this.usage(scope) };
    }
    if (replacement.length === 0) {
      return this.remove(scope, oldText);
    }

    const matches = this.entries[scope].filter((entry) => entry.content.includes(needle));
    if (matches.length === 0) {
      return {
        success: false,
        message: `No entry contains "${needle}".`,
        usage: this.usage(scope),
        currentEntries: this.entries[scope],
      };
    }
    if (matches.length > 1) {
      return {
        success: false,
        message: `Ambiguous: ${matches.length} entries match "${needle}".`,
        usage: this.usage(scope),
        currentEntries: this.entries[scope],
      };
    }

    const target = matches[0]!;
    const nextContent = target.content.replace(needle, replacement);
    const next = this.entries[scope].map((entry) =>
      entry === target ? { content: nextContent, importance: entry.importance } : entry,
    );
    const serialized = serializeEntries(next);
    const used = charCount(serialized);
    if (used > this.limits[scope]) {
      return {
        success: false,
        message: `Over budget (${used} / ${this.limits[scope]} chars).`,
        usage: this.usage(scope),
        currentEntries: this.entries[scope],
      };
    }

    this.entries[scope] = next;
    await this.persist(scope);
    return { success: true, message: `Updated ${scope} entry.`, usage: this.usage(scope) };
  }

  /** Remove the first entry that contains `oldText`. */
  async remove(scope: MemoryScope, oldText: string): Promise<MemoryMutationResult> {
    const needle = oldText.trim();
    if (needle.length === 0) {
      return { success: false, message: "old_text cannot be empty.", usage: this.usage(scope) };
    }

    const index = this.entries[scope].findIndex((entry) => entry.content.includes(needle));
    if (index < 0) {
      return {
        success: false,
        message: `No entry contains "${needle}".`,
        usage: this.usage(scope),
        currentEntries: this.entries[scope],
      };
    }

    this.entries[scope].splice(index, 1);
    await this.persist(scope);
    return { success: true, message: `Removed ${scope} entry.`, usage: this.usage(scope) };
  }

  /**
   * Evict the lowest-importance entries until the serialized scope is within
   * its budget. Returns the number of entries removed.
   */
  async prune(scope: MemoryScope): Promise<{ removed: number; usage: MemoryUsage }> {
    let removed = 0;
    while (this.entries[scope].length > 0 && charCount(serializeEntries(this.entries[scope])) > this.limits[scope]) {
      let lowestIndex = 0;
      let lowestImportance = this.entries[scope][0]!.importance;
      for (let i = 1; i < this.entries[scope].length; i++) {
        if (this.entries[scope][i]!.importance < lowestImportance) {
          lowestImportance = this.entries[scope][i]!.importance;
          lowestIndex = i;
        }
      }
      this.entries[scope].splice(lowestIndex, 1);
      removed++;
    }
    if (removed > 0) {
      await this.persist(scope);
    }
    return { removed, usage: this.usage(scope) };
  }

  /** Current entries for a scope. */
  getEntries(scope: MemoryScope): MemoryEntry[] {
    return this.entries[scope].slice();
  }

  /** Current usage for a scope. */
  usage(scope: MemoryScope): MemoryUsage {
    return {
      used: charCount(serializeEntries(this.entries[scope])),
      limit: this.limits[scope],
      count: this.entries[scope].length,
    };
  }

  /** Serialized file content for a scope. */
  serialize(scope: MemoryScope): string {
    return serializeEntries(this.entries[scope]);
  }

  private async persist(scope: MemoryScope): Promise<void> {
    if (!this.fs || !this.getPath) return;
    const path = this.getPath(scope);
    await this.fs.writeFileAtomic(path, serializeEntries(this.entries[scope]));
  }
}
