/**
 * Data types for the built-in bounded memory store.
 *
 * Mirrors the Python `tools/memory_tool.py` MEMORY_SCHEMA surface and the
 * Rust `src/commands/memory.rs` persistence shapes. The store is bounded by a
 * character budget (used as a lightweight, code-point-correct proxy for tokens
 * so the agent loop can run without a tokenizer).
 */

/** Memory file scope. */
export type MemoryScope = "memory" | "user";

/** A single durable memory entry. */
export interface MemoryEntry {
  /** Stable content text. */
  content: string;
  /** Importance score in [0, 1]; used by prune to evict low-value entries. */
  importance: number;
  /** Optional short label (not persisted in the §-delimited file format). */
  label?: string;
}

/** Per-scope capacity snapshot. */
export interface MemoryUsage {
  used: number;
  limit: number;
  count: number;
}

/** Result of a single memory mutation. */
export interface MemoryMutationResult {
  success: boolean;
  /** Human-readable message; may include capacity hints on error. */
  message: string;
  /** Post-mutation usage for the affected scope. */
  usage?: MemoryUsage;
  /** Current entries when the caller needs to self-correct (e.g. multi-match). */
  currentEntries?: MemoryEntry[];
}

/** Search result. */
export interface MemorySearchResult {
  entries: MemoryEntry[];
  usage: MemoryUsage;
}

/** FS seam so the store can be tested in-memory and later backed by Rust IPC. */
export interface MemoryFs {
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** Store configuration. */
export interface BoundedMemoryStoreOptions {
  /** Character limit for MEMORY.md (default 2200). */
  memoryCharLimit?: number;
  /** Character limit for USER.md (default 1375). */
  userCharLimit?: number;
  /** Optional FS adapter; absent writes are held only in memory. */
  fs?: MemoryFs;
  /** Optional path resolver; absent paths are held only in memory. */
  getPath?: (scope: MemoryScope) => string;
}

/** Tool action names. */
export type MemoryToolAction = "add_memory" | "search_memory" | "update_memory" | "delete_memory";
