import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";

import {
  composerPrefillAtom,
  consumeSessionComposerDraftAtom,
  sessionComposerDraftsAtom,
  setSessionComposerDraftAtom,
  withSessionComposerDraft,
  withoutSessionComposerDraft,
} from "./panel";

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

describe("session composer draft bridge", () => {
  it("stores drafts by session id", () => {
    const drafts = withSessionComposerDraft({}, "s1", "migration prompt", 11);
    expect(drafts).toEqual({ s1: { text: "migration prompt", nonce: 11 } });
  });

  it("ignores empty session ids", () => {
    const drafts = withSessionComposerDraft({}, "   ", "migration prompt", 11);
    expect(drafts).toEqual({});
  });

  it("removes a single draft without touching others", () => {
    const drafts = {
      s1: { text: "one", nonce: 1 },
      s2: { text: "two", nonce: 2 },
    };
    expect(withoutSessionComposerDraft(drafts, "s1")).toEqual({
      s2: { text: "two", nonce: 2 },
    });
  });

  it("consumes a session draft once", () => {
    const store = createStore();
    store.set(setSessionComposerDraftAtom, { sessionId: "s1", text: "draft", nonce: 7 });
    expect(store.get(sessionComposerDraftsAtom)).toEqual({ s1: { text: "draft", nonce: 7 } });

    expect(store.set(consumeSessionComposerDraftAtom, "s1")).toEqual({ text: "draft", nonce: 7 });
    expect(store.get(sessionComposerDraftsAtom)).toEqual({});
    expect(store.set(consumeSessionComposerDraftAtom, "s1")).toBeNull();
  });
});
