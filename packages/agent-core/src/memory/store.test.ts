import { describe, expect, it } from "vitest";
import {
  BoundedMemoryStore,
  charCount,
  parseMemoryEntries,
  serializeEntries,
} from "./store.js";
import type { MemoryEntry, MemoryFs, MemoryScope } from "./types.js";

function makeFs(): { fs: MemoryFs; reads: string[]; writes: [string, string][] } {
  const files = new Map<string, string>();
  const reads: string[] = [];
  const writes: [string, string][] = [];
  return {
    fs: {
      readFile: async (path: string) => {
        reads.push(path);
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      writeFileAtomic: async (path: string, content: string) => {
        writes.push([path, content]);
        files.set(path, content);
      },
      exists: async (path: string) => files.has(path),
    },
    reads,
    writes,
  };
}

function sampleEntries(): MemoryEntry[] {
  return [
    { content: "First entry", importance: 0.5 },
    { content: "Second entry", importance: 0.7 },
  ];
}

describe("charCount", () => {
  it("counts Unicode code points, not bytes", () => {
    expect(charCount("中文🙂")).toBe(3);
  });
});

describe("parseMemoryEntries", () => {
  it("parses §-delimited entries", () => {
    const entries = parseMemoryEntries(" first \n§\n\nsecond\n\n§\n  ");
    expect(entries).toEqual([
      { content: "first", importance: 0.5 },
      { content: "second", importance: 0.5 },
    ]);
  });

  it("returns empty array for blank input", () => {
    expect(parseMemoryEntries("   ")).toEqual([]);
  });
});

describe("serializeEntries", () => {
  it("serializes without empty items", () => {
    const serialized = serializeEntries([
      { content: " alpha ", importance: 0.5 },
      { content: "", importance: 0.5 },
      { content: "beta", importance: 0.5 },
    ]);
    expect(serialized).toBe("alpha\n§\nbeta");
  });
});

describe("BoundedMemoryStore", () => {
  it("loads entries from raw content", () => {
    const store = new BoundedMemoryStore();
    store.load("memory", "a\n§\nb");
    expect(store.getEntries("memory")).toHaveLength(2);
  });

  it("adds an entry", async () => {
    const store = new BoundedMemoryStore();
    const result = await store.add("memory", "hello");
    expect(result.success).toBe(true);
    expect(store.getEntries("memory")).toEqual([expect.objectContaining({ content: "hello" })]);
  });

  it("rejects empty content", async () => {
    const store = new BoundedMemoryStore();
    const result = await store.add("memory", "   ");
    expect(result.success).toBe(false);
    expect(result.message).toContain("empty");
  });

  it("rejects exact duplicates", async () => {
    const store = new BoundedMemoryStore();
    await store.add("memory", "hello");
    const result = await store.add("memory", "hello");
    expect(result.success).toBe(false);
    expect(result.message).toContain("duplicate");
  });

  it("enforces the character budget", async () => {
    const store = new BoundedMemoryStore({ memoryCharLimit: 10 });
    const result = await store.add("memory", "this is a long entry");
    expect(result.success).toBe(false);
    expect(result.message).toContain("Over budget");
  });

  it("updates by substring match", async () => {
    const store = new BoundedMemoryStore();
    await store.add("memory", "hello world");
    const result = await store.update("memory", "hello", "hi");
    expect(result.success).toBe(true);
    expect(store.serialize("memory")).toBe("hi world");
  });

  it("rejects ambiguous updates", async () => {
    const store = new BoundedMemoryStore();
    await store.add("memory", "alpha one");
    await store.add("memory", "alpha two");
    const result = await store.update("memory", "alpha", "beta");
    expect(result.success).toBe(false);
    expect(result.message).toContain("Ambiguous");
  });

  it("removes by substring match", async () => {
    const store = new BoundedMemoryStore();
    await store.add("memory", "keep");
    await store.add("memory", "remove me");
    const result = await store.remove("memory", "remove");
    expect(result.success).toBe(true);
    expect(store.getEntries("memory")).toHaveLength(1);
  });

  it("searches entries", () => {
    const store = new BoundedMemoryStore();
    store.load("memory", "foo\n§\nbar\n§\nfoobar");
    const result = store.search("memory", "foo");
    expect(result.entries).toHaveLength(2);
  });

  it("prunes lowest-importance entries to fit budget", async () => {
    const store = new BoundedMemoryStore({ memoryCharLimit: 10 });
    // Load an over-budget state directly; prune should evict entries until under budget.
    store.load("memory", "low\n§\nhigh\n§\nmed");
    const { removed } = await store.prune("memory");
    expect(removed).toBeGreaterThan(0);
    expect(charCount(store.serialize("memory"))).toBeLessThanOrEqual(10);
  });

  it("persists via FS adapter", async () => {
    const { fs, writes } = makeFs();
    const store = new BoundedMemoryStore({
      fs,
      getPath: (scope: MemoryScope) => `/${scope}.md`,
    });
    await store.add("memory", "persisted");
    expect(writes).toEqual([["/memory.md", "persisted"]]);
  });

  it("reports usage", () => {
    const store = new BoundedMemoryStore({ memoryCharLimit: 100 });
    store.load("memory", "one\n§\ntwo");
    // "one" + "\n§\n" + "two" = 9 code points.
    expect(store.usage("memory")).toEqual({ used: 9, limit: 100, count: 2 });
  });
});
