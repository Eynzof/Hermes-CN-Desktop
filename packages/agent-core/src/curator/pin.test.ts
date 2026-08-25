import { describe, expect, it } from "vitest";
import { CuratorEngine, createStubCollector } from "./engine.js";
import type { CuratorSnapshot } from "./types.js";

describe("curator pinning/backup/rollback (P1-24)", () => {
  const backup = {
    backup: async (s: CuratorSnapshot) => ({ ok: true, path: `/backup/${s.id}` }),
    list: async () => [{ snapshotId: "s1", path: "/backup/s1" }],
    restore: async (id: string) => ({ ok: true, paths: ["context.md"] }),
  };

  it("pins snapshots so they are never pruned", async () => {
    const engine = new CuratorEngine(createStubCollector(), backup);
    const snap = await engine.snapshot("session-1");
    expect(engine.isPinned(snap.id)).toBe(false);
    expect(engine.pin(snap.id)).toBe(true);
    expect(engine.isPinned(snap.id)).toBe(true);
    expect(engine.pinnedSnapshots().map((s) => s.id)).toContain(snap.id);
    expect(engine.unpin(snap.id)).toBe(true);
    expect(engine.isPinned(snap.id)).toBe(false);
  });

  it("rejects pinning unknown snapshots", async () => {
    const engine = new CuratorEngine(createStubCollector(), backup);
    expect(engine.pin("missing")).toBe(false);
  });

  it("rolls back to a snapshot via the backup backend", async () => {
    const engine = new CuratorEngine(createStubCollector(), backup);
    const snap = await engine.snapshot("session-1");
    const result = await engine.rollback(snap.id);
    expect(result.ok).toBe(true);
    expect(result.paths).toEqual(["context.md"]);
  });

  it("lists backups from the backend", async () => {
    const engine = new CuratorEngine(createStubCollector(), backup);
    expect(await engine.listBackups()).toEqual([{ snapshotId: "s1", path: "/backup/s1" }]);
  });
});
