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
  it("defaults to large when nothing is stored", async () => {
    const { conversationWidthModeAtom } = await loadUi();
    const store = createStore();
    expect(store.get(conversationWidthModeAtom)).toBe("large");
  });

  it("restores a supported width from the UI store", async () => {
    const { conversationWidthModeAtom } = await loadUi({
      "hermes.conversation-width": "large",
    });
    const store = createStore();
    expect(store.get(conversationWidthModeAtom)).toBe("large");
  });

  it("normalizes unsupported stored and written values back to large", async () => {
    const { conversationWidthModeAtom, uiStore } = await loadUi({
      "hermes.conversation-width": "wide",
    });
    const store = createStore();
    expect(store.get(conversationWidthModeAtom)).toBe("large");

    store.set(conversationWidthModeAtom, "full");
    expect(uiStore.readUiValue("hermes.conversation-width", "")).toBe("full");

    store.set(conversationWidthModeAtom, "tiny" as never);
    expect(store.get(conversationWidthModeAtom)).toBe("large");
    expect(uiStore.readUiValue("hermes.conversation-width", "")).toBe("large");
  });

  it("maps the four width modes to concrete CSS max-width values", async () => {
    const { conversationWidthMaxWidth } = await loadUi();
    expect(conversationWidthMaxWidth("small")).toBe("780px");
    expect(conversationWidthMaxWidth("medium")).toBe("960px");
    expect(conversationWidthMaxWidth("large")).toBe("1006px");
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

describe("notification settings atoms (persisted)", () => {
  const atomKeyPairs = [
    ["notifySystemAtom", "hermes.notify-system"],
    ["notifySoundAtom", "hermes.notify-sound"],
    ["notifyOnCompleteAtom", "hermes.notify-on-complete"],
    ["notifyOnApprovalAtom", "hermes.notify-on-approval"],
    ["notifyOnlyBackgroundAtom", "hermes.notify-only-background"],
  ] as const;

  it("all five toggles default to enabled", async () => {
    const ui = await loadUi();
    const store = createStore();
    for (const [atomName] of atomKeyPairs) {
      expect(store.get(ui[atomName])).toBe(true);
    }
  });

  it("persists toggles under their hermes.notify-* keys", async () => {
    const ui = await loadUi();
    const store = createStore();
    for (const [atomName, key] of atomKeyPairs) {
      store.set(ui[atomName], false);
      expect(ui.uiStore.readUiValue(key, true)).toBe(false);
      store.set(ui[atomName], true);
      expect(ui.uiStore.readUiValue(key, false)).toBe(true);
    }
  });

  it("restores stored false values and treats non-boolean junk as enabled", async () => {
    const ui = await loadUi({
      "hermes.notify-system": false,
      "hermes.notify-sound": "yes",
    });
    const store = createStore();
    expect(store.get(ui.notifySystemAtom)).toBe(false);
    expect(store.get(ui.notifySoundAtom)).toBe(true);
  });

  it("readNotificationSettings mirrors the persisted kv values", async () => {
    const ui = await loadUi({ "hermes.notify-on-complete": false });
    expect(ui.readNotificationSettings()).toEqual({
      system: true,
      sound: true,
      onComplete: false,
      onApproval: true,
      onlyBackground: true,
    });

    const store = createStore();
    store.set(ui.notifyOnlyBackgroundAtom, false);
    expect(ui.readNotificationSettings().onlyBackground).toBe(false);
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

describe("assistant display profile atoms (persisted)", () => {
  it("defaults to Hermes and restores a saved custom name", async () => {
    const { assistantDisplayNameAtom } = await loadUi();
    const store = createStore();
    expect(store.get(assistantDisplayNameAtom)).toBe("Hermes");

    const restored = await loadUi({ "hermes.assistant-display-name": "Claudia" });
    const restoredStore = createStore();
    expect(restoredStore.get(restored.assistantDisplayNameAtom)).toBe("Claudia");
  });

  it("trims, limits and persists custom assistant names", async () => {
    const { assistantDisplayNameAtom, uiStore } = await loadUi();
    const store = createStore();
    store.set(assistantDisplayNameAtom, "  Claudia   Agent  ");
    expect(store.get(assistantDisplayNameAtom)).toBe("Claudia Agent");
    expect(uiStore.readUiValue("hermes.assistant-display-name", "")).toBe("Claudia Agent");

    store.set(assistantDisplayNameAtom, "");
    expect(store.get(assistantDisplayNameAtom)).toBe("Hermes");
    expect(uiStore.readUiValue("hermes.assistant-display-name", "fallback")).toBe("");
  });

  it("accepts image data URLs and rejects non-image avatar values", async () => {
    const { assistantAvatarDataUrlAtom, uiStore } = await loadUi();
    const store = createStore();
    const avatar = "data:image/png;base64,AAAA";
    store.set(assistantAvatarDataUrlAtom, avatar);
    expect(store.get(assistantAvatarDataUrlAtom)).toBe(avatar);
    expect(uiStore.readUiValue("hermes.assistant-avatar-data-url", "")).toBe(avatar);

    store.set(assistantAvatarDataUrlAtom, "https://example.test/avatar.png");
    expect(store.get(assistantAvatarDataUrlAtom)).toBe("");
    expect(uiStore.readUiValue("hermes.assistant-avatar-data-url", "fallback")).toBe("");
  });
});
