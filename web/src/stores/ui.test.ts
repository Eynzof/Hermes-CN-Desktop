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

describe("composerSubmitShortcutAtom (persisted)", () => {
  it("defaults to Enter submit when nothing is stored", async () => {
    const { composerSubmitShortcutAtom } = await loadUi();
    const store = createStore();
    expect(store.get(composerSubmitShortcutAtom)).toBe("enter");
  });

  it("restores Ctrl+Enter submit from the UI store", async () => {
    const { composerSubmitShortcutAtom } = await loadUi({
      "hermes.composer-submit-shortcut": "ctrl-enter",
    });
    const store = createStore();
    expect(store.get(composerSubmitShortcutAtom)).toBe("ctrl-enter");
  });

  it("persists shortcut changes and normalizes unsupported values", async () => {
    const { composerSubmitShortcutAtom, uiStore } = await loadUi();
    const store = createStore();
    store.set(composerSubmitShortcutAtom, "ctrl-enter");
    expect(uiStore.readUiValue("hermes.composer-submit-shortcut", "")).toBe("ctrl-enter");

    store.set(composerSubmitShortcutAtom, "shift-enter" as never);
    expect(store.get(composerSubmitShortcutAtom)).toBe("enter");
    expect(uiStore.readUiValue("hermes.composer-submit-shortcut", "")).toBe("enter");
  });
});

describe("conversationWidthModeAtom (persisted)", () => {
  it("defaults to medium when nothing is stored", async () => {
    const { conversationWidthModeAtom } = await loadUi();
    const store = createStore();
    expect(store.get(conversationWidthModeAtom)).toBe("medium");
  });

  it("restores a supported width from the UI store", async () => {
    const { conversationWidthModeAtom } = await loadUi({
      "hermes.conversation-width": "large",
    });
    const store = createStore();
    expect(store.get(conversationWidthModeAtom)).toBe("large");
  });

  it("normalizes unsupported stored and written values back to medium", async () => {
    const { conversationWidthModeAtom, uiStore } = await loadUi({
      "hermes.conversation-width": "wide",
    });
    const store = createStore();
    expect(store.get(conversationWidthModeAtom)).toBe("medium");

    store.set(conversationWidthModeAtom, "full");
    expect(uiStore.readUiValue("hermes.conversation-width", "")).toBe("full");

    store.set(conversationWidthModeAtom, "tiny" as never);
    expect(store.get(conversationWidthModeAtom)).toBe("medium");
    expect(uiStore.readUiValue("hermes.conversation-width", "")).toBe("medium");
  });

  it("maps the four width modes to concrete CSS max-width values", async () => {
    const { conversationWidthMaxWidth } = await loadUi();
    expect(conversationWidthMaxWidth("small")).toBe("640px");
    expect(conversationWidthMaxWidth("medium")).toBe("780px");
    expect(conversationWidthMaxWidth("large")).toBe("960px");
    expect(conversationWidthMaxWidth("full")).toBe("100%");
  });
});

describe("conversationFontSizeAtom (persisted)", () => {
  it("defaults to standard when nothing is stored", async () => {
    const { conversationFontSizeAtom } = await loadUi();
    const store = createStore();
    expect(store.get(conversationFontSizeAtom)).toBe("standard");
  });

  it("restores a supported font size from the UI store", async () => {
    const { conversationFontSizeAtom } = await loadUi({
      "hermes.conversation-font-size": "large",
    });
    const store = createStore();
    expect(store.get(conversationFontSizeAtom)).toBe("large");
  });

  it("persists font size changes and normalizes unsupported values", async () => {
    const { conversationFontSizeAtom, uiStore } = await loadUi({
      "hermes.conversation-font-size": "tiny",
    });
    const store = createStore();
    expect(store.get(conversationFontSizeAtom)).toBe("standard");

    store.set(conversationFontSizeAtom, "small");
    expect(uiStore.readUiValue("hermes.conversation-font-size", "")).toBe("small");

    store.set(conversationFontSizeAtom, "huge" as never);
    expect(store.get(conversationFontSizeAtom)).toBe("standard");
    expect(uiStore.readUiValue("hermes.conversation-font-size", "")).toBe("standard");
  });

  it("maps the three font size modes to concrete CSS variables", async () => {
    const { conversationFontSizeVars } = await loadUi();
    expect(conversationFontSizeVars("small")).toEqual({ fontSize: "13px", lineHeight: "1.72" });
    expect(conversationFontSizeVars("standard")).toEqual({ fontSize: "14px", lineHeight: "1.78" });
    expect(conversationFontSizeVars("large")).toEqual({ fontSize: "15.5px", lineHeight: "1.82" });
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

describe("runtimeUpdatingAtom", () => {
  it("defaults to { active: false }", async () => {
    const { runtimeUpdatingAtom } = await loadUi();
    const store = createStore();
    expect(store.get(runtimeUpdatingAtom)).toEqual({ active: false });
  });

  it("carries the mode when activating", async () => {
    const { runtimeUpdatingAtom } = await loadUi();
    const store = createStore();
    store.set(runtimeUpdatingAtom, { active: true, mode: "install" });
    expect(store.get(runtimeUpdatingAtom)).toEqual({ active: true, mode: "install" });
    store.set(runtimeUpdatingAtom, { active: true, mode: "rollback" });
    expect(store.get(runtimeUpdatingAtom)).toEqual({ active: true, mode: "rollback" });
  });
});
