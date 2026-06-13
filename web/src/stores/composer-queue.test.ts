import { describe, expect, it } from "vitest";
import type { ComposerAttachment } from "@/components/chat/composer-types";
import {
  deserializeQueue,
  enqueue,
  entriesFor,
  removeEntry,
  serializeQueue,
  shouldAutoDrainOnSettle,
  updateEntry,
  type QueuedPromptEntry,
} from "./composer-queue";

function entry(overrides: Partial<QueuedPromptEntry>): QueuedPromptEntry {
  return { id: "e1", text: "hi", attachments: [], queuedAt: 1, ...overrides };
}

describe("queue reducers", () => {
  it("enqueues per session and lists in order", () => {
    let state = {};
    state = enqueue(state, "s1", entry({ id: "a" }));
    state = enqueue(state, "s1", entry({ id: "b" }));
    state = enqueue(state, "s2", entry({ id: "c" }));
    expect(entriesFor(state, "s1").map((e) => e.id)).toEqual(["a", "b"]);
    expect(entriesFor(state, "s2").map((e) => e.id)).toEqual(["c"]);
    expect(entriesFor(state, "missing")).toEqual([]);
  });

  it("removes an entry and drops empty session keys", () => {
    let state = enqueue({}, "s1", entry({ id: "a" }));
    state = removeEntry(state, "s1", "a");
    expect(state).toEqual({});
  });

  it("updates an entry's text in place", () => {
    let state = enqueue({}, "s1", entry({ id: "a", text: "old" }));
    state = updateEntry(state, "s1", "a", { text: "new" });
    expect(entriesFor(state, "s1")[0]!.text).toBe("new");
  });
});

describe("shouldAutoDrainOnSettle", () => {
  it("fires only on a busy→idle transition with a non-empty queue", () => {
    expect(shouldAutoDrainOnSettle({ isBusy: false, wasBusy: true, queueLength: 1, userInterrupted: false })).toBe(true);
    expect(shouldAutoDrainOnSettle({ isBusy: true, wasBusy: true, queueLength: 1, userInterrupted: false })).toBe(false);
    expect(shouldAutoDrainOnSettle({ isBusy: false, wasBusy: false, queueLength: 1, userInterrupted: false })).toBe(false);
    expect(shouldAutoDrainOnSettle({ isBusy: false, wasBusy: true, queueLength: 0, userInterrupted: false })).toBe(false);
  });

  it("suppresses one drain after an explicit Stop", () => {
    expect(shouldAutoDrainOnSettle({ isBusy: false, wasBusy: true, queueLength: 2, userInterrupted: true })).toBe(false);
  });
});

describe("serialization", () => {
  it("round-trips path attachments and drops transient browser files", () => {
    const pathAttachment = { id: "p", source: "path", path: "/a/b.txt", name: "b.txt", kind: "file", status: "ready" } as ComposerAttachment;
    const browserAttachment = { id: "f", source: "browser", name: "x.png", kind: "image", status: "ready", file: {} as File, previewUrl: "blob:x" } as ComposerAttachment;
    const state = enqueue({}, "s1", entry({ attachments: [pathAttachment, browserAttachment] }));
    const restored = deserializeQueue(serializeQueue(state));
    expect(entriesFor(restored, "s1")[0]!.attachments).toEqual([
      { id: "p", source: "path", path: "/a/b.txt", name: "b.txt", kind: "file", status: "ready" },
    ]);
  });

  it("tolerates malformed JSON", () => {
    expect(deserializeQueue("not json")).toEqual({});
    expect(deserializeQueue(null)).toEqual({});
  });
});
