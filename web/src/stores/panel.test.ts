import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";

import { composerPrefillAtom } from "./panel";

describe("composerPrefillAtom", () => {
  it("starts as null", () => {
    const store = createStore();
    expect(store.get(composerPrefillAtom)).toBeNull();
  });

  it("accepts a text + nonce payload and round-trips it", () => {
    const store = createStore();
    store.set(composerPrefillAtom, { text: "draft prompt", nonce: 1 });
    expect(store.get(composerPrefillAtom)).toEqual({
      text: "draft prompt",
      nonce: 1,
    });
  });

  it("notifies subscribers when set", () => {
    const store = createStore();
    const snapshots: Array<{ text: string; nonce: number } | null> = [];
    const unsubscribe = store.sub(composerPrefillAtom, () => {
      snapshots.push(store.get(composerPrefillAtom));
    });
    store.set(composerPrefillAtom, { text: "a", nonce: 1 });
    store.set(composerPrefillAtom, { text: "b", nonce: 2 });
    store.set(composerPrefillAtom, null);
    unsubscribe();
    expect(snapshots).toEqual([
      { text: "a", nonce: 1 },
      { text: "b", nonce: 2 },
      null,
    ]);
  });

  it("uses nonce to allow re-triggering with the same text", () => {
    // This pins the contract: bumping nonce while text is identical should
    // still emit a state change so PanelComposer's effect re-fires.
    const store = createStore();
    const seen: Array<{ text: string; nonce: number } | null> = [];
    const unsubscribe = store.sub(composerPrefillAtom, () => {
      seen.push(store.get(composerPrefillAtom));
    });
    store.set(composerPrefillAtom, { text: "same", nonce: 1 });
    store.set(composerPrefillAtom, { text: "same", nonce: 2 });
    unsubscribe();
    expect(seen).toHaveLength(2);
    expect(seen[0]?.nonce).toBe(1);
    expect(seen[1]?.nonce).toBe(2);
  });
});
