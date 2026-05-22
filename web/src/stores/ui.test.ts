import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadUi(seed: Record<string, unknown> = {}) {
  vi.resetModules();
  const uiStore = await import("@/lib/ui-store");
  uiStore.__resetUiStoreForTests(seed);
  const ui = await import("./ui");
  return { ...ui, uiStore };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("activeSessionIdAtom", () => {
  it("starts null and accepts a string id", async () => {
    const { activeSessionIdAtom } = await loadUi();
    const store = createStore();
    expect(store.get(activeSessionIdAtom)).toBeNull();
    store.set(activeSessionIdAtom, "session-1");
    expect(store.get(activeSessionIdAtom)).toBe("session-1");
  });
});

describe("sidebarSearchAtom", () => {
  it("defaults to empty string", async () => {
    const { sidebarSearchAtom } = await loadUi();
    const store = createStore();
    expect(store.get(sidebarSearchAtom)).toBe("");
  });

  it("round-trips a search query", async () => {
    const { sidebarSearchAtom } = await loadUi();
    const store = createStore();
    store.set(sidebarSearchAtom, "tavily");
    expect(store.get(sidebarSearchAtom)).toBe("tavily");
  });
});

describe("activeProfileAtom (persisted)", () => {
  it("defaults to 'default' when nothing is stored", async () => {
    const { activeProfileAtom } = await loadUi();
    const store = createStore();
    expect(store.get(activeProfileAtom)).toBe("default");
  });

  it("persists writes to the UI store under hermes.active-profile", async () => {
    const { activeProfileAtom, uiStore } = await loadUi();
    const store = createStore();
    store.set(activeProfileAtom, "work");
    expect(uiStore.readUiValue("hermes.active-profile", "")).toBe("work");
  });
});

describe("showReasoningAtom (persisted)", () => {
  it("defaults to false", async () => {
    const { showReasoningAtom } = await loadUi();
    const store = createStore();
    expect(store.get(showReasoningAtom)).toBe(false);
  });

  it("persists boolean toggles", async () => {
    const { showReasoningAtom, uiStore } = await loadUi();
    const store = createStore();
    store.set(showReasoningAtom, true);
    expect(uiStore.readUiValue("hermes.show-reasoning", false)).toBe(true);
    store.set(showReasoningAtom, false);
    expect(uiStore.readUiValue("hermes.show-reasoning", true)).toBe(false);
  });
});

describe("profileSwitchingAtom", () => {
  it("defaults to { active: false }", async () => {
    const { profileSwitchingAtom } = await loadUi();
    const store = createStore();
    expect(store.get(profileSwitchingAtom)).toEqual({ active: false });
  });

  it("carries the targetName when activating", async () => {
    const { profileSwitchingAtom } = await loadUi();
    const store = createStore();
    store.set(profileSwitchingAtom, { active: true, targetName: "work" });
    expect(store.get(profileSwitchingAtom)).toEqual({
      active: true,
      targetName: "work",
    });
  });

  it("notifies subscribers on each change", async () => {
    const { profileSwitchingAtom } = await loadUi();
    const store = createStore();
    let calls = 0;
    const unsubscribe = store.sub(profileSwitchingAtom, () => {
      calls += 1;
    });
    store.set(profileSwitchingAtom, { active: true, targetName: "a" });
    store.set(profileSwitchingAtom, { active: false });
    unsubscribe();
    expect(calls).toBe(2);
  });
});
