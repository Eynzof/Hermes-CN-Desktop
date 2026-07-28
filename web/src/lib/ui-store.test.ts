import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiStoreSnapshot } from "./runtime";

// ── Helpers ──────────────────────────────────────────────────────────────────

const BACKUP_KEY = "hermes_ui_backup";
const EMPTY_SNAPSHOT: UiStoreSnapshot = { kv: {} };

function fakeBridge(overrides: Partial<UiStoreSnapshot> = {}): UiStoreSnapshot {
  return { kv: { ...overrides.kv } };
}

async function loadUiStore() {
  vi.resetModules();
  // Clear module-level state (kvCache) before each import
  const mod = await import("./ui-store");
  return mod;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface MockBridge {
  uiStoreSnapshot: ReturnType<typeof vi.fn>;
  uiStoreSetKv: ReturnType<typeof vi.fn>;
  uiStoreRemoveKv: ReturnType<typeof vi.fn>;
}

function installBridge(snapshot?: UiStoreSnapshot): MockBridge {
  const bridge: MockBridge = {
    uiStoreSnapshot: vi.fn().mockResolvedValue(snapshot ?? EMPTY_SNAPSHOT),
    uiStoreSetKv: vi.fn().mockResolvedValue(true),
    uiStoreRemoveKv: vi.fn().mockResolvedValue(true),
  };
  (window as any).hermesDesktop = bridge;
  return bridge;
}

function removeBridge(): void {
  delete (window as any).hermesDesktop;
}

/** Clear all localStorage keys compatibly — jsdom may not implement .clear(). */
const lsStore: Record<string, string> = {};
const mockStorage: Storage = {
  getItem: (key: string) => lsStore[key] ?? null,
  setItem: (key: string, value: string) => { lsStore[key] = String(value); },
  removeItem: (key: string) => { delete lsStore[key]; },
  clear: () => { Object.keys(lsStore).forEach((k) => delete lsStore[k]); },
  get length() { return Object.keys(lsStore).length; },
  key: (index: number) => Object.keys(lsStore)[index] ?? null,
};

beforeEach(() => {
  // Vitest runs this file in Node, so provide the browser globals used by ui-store.
  Object.keys(lsStore).forEach((k) => delete lsStore[k]);
  vi.stubGlobal("window", { localStorage: mockStorage });
  vi.stubGlobal("localStorage", mockStorage);
});

afterEach(() => {
  delete (globalThis as any).window?.hermesDesktop;
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("readUiValue", () => {
  it("returns the stored value when key exists", async () => {
    const { __resetUiStoreForTests, readUiValue } = await loadUiStore();
    __resetUiStoreForTests({ theme: "dark" });
    expect(readUiValue("theme", "light")).toBe("dark");
  });

  it("returns the fallback when key does not exist", async () => {
    const { __resetUiStoreForTests, readUiValue } = await loadUiStore();
    __resetUiStoreForTests({});
    expect(readUiValue("theme", "light")).toBe("light");
  });

  it("returns a clone, not the original reference", async () => {
    const { __resetUiStoreForTests, readUiValue } = await loadUiStore();
    const original = { theme: "dark", scale: "lg" };
    __resetUiStoreForTests({ config: original });
    const result = readUiValue<Record<string, unknown>>("config", {});
    expect(result).toEqual(original);
    // Mutating the returned value should NOT affect the cache
    result.theme = "light";
    const second = readUiValue<Record<string, unknown>>("config", {});
    expect(second.theme).toBe("dark");
  });
});

describe("writeUiValue", () => {
  describe("Web mode (no native bridge)", () => {
    beforeEach(() => {
      removeBridge();
    });

    it("saves to in-memory kvCache so readUiValue returns the value", async () => {
      const { writeUiValue, readUiValue, __resetUiStoreForTests } = await loadUiStore();
      __resetUiStoreForTests({});
      writeUiValue("theme", "dark");
      expect(readUiValue("theme", "light")).toBe("dark");
    });

    it("persists to localStorage as a fallback", async () => {
      const { writeUiValue, __resetUiStoreForTests } = await loadUiStore();
      __resetUiStoreForTests({});
      writeUiValue("theme", "dark");
      const raw = localStorage.getItem(BACKUP_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed).toEqual({ theme: "dark" });
    });

    it("overwrites localStorage with the full kvCache on each write", async () => {
      const { writeUiValue, __resetUiStoreForTests } = await loadUiStore();
      __resetUiStoreForTests({ existing: "value" });
      writeUiValue("theme", "dark");
      const raw = localStorage.getItem(BACKUP_KEY);
      const parsed = JSON.parse(raw!);
      expect(parsed).toEqual({ existing: "value", theme: "dark" });
    });

    it("does not throw when localStorage is full", async () => {
      // Replace localStorage with one that throws on setItem
      const throwingLs = { ...mockStorage, setItem: vi.fn().mockImplementation(() => { throw new Error("QuotaExceededError"); }) };
      Object.defineProperty(globalThis, "localStorage", { value: throwingLs, configurable: true, writable: true });
      Object.defineProperty(window, "localStorage", { value: throwingLs, configurable: true, writable: true });

      const { writeUiValue, __resetUiStoreForTests, readUiValue } = await loadUiStore();
      __resetUiStoreForTests({});
      expect(() => writeUiValue("theme", "dark")).not.toThrow();
      // In-memory cache should still be updated even if localStorage fails
      expect(readUiValue("theme", "light")).toBe("dark");
    });
  });

  describe("Tauri mode (with native bridge)", () => {
    it("calls bridge.uiStoreSetKv with the key and value", async () => {
      const bridge = installBridge();
      const { writeUiValue, __resetUiStoreForTests } = await loadUiStore();
      __resetUiStoreForTests({});
      writeUiValue("theme", "dark");
      await flushMicrotasks();
      expect(bridge.uiStoreSetKv).toHaveBeenCalledWith({ key: "theme", value: "dark" });
    });

    it("does NOT write to localStorage when bridge is available", async () => {
      installBridge();
      const { writeUiValue, __resetUiStoreForTests } = await loadUiStore();
      __resetUiStoreForTests({});
      writeUiValue("theme", "dark");
      expect(localStorage.getItem(BACKUP_KEY)).toBeNull();
    });

    it("still updates in-memory kvCache", async () => {
      installBridge();
      const { writeUiValue, readUiValue, __resetUiStoreForTests } = await loadUiStore();
      __resetUiStoreForTests({});
      writeUiValue("theme", "dark");
      expect(readUiValue("theme", "light")).toBe("dark");
    });
  });
});

describe("removeUiValue", () => {
  describe("Web mode (no native bridge)", () => {
    beforeEach(() => {
      removeBridge();
    });

    it("removes the key from in-memory kvCache", async () => {
      const { writeUiValue, removeUiValue, readUiValue, __resetUiStoreForTests } = await loadUiStore();
      __resetUiStoreForTests({});
      writeUiValue("theme", "dark");
      removeUiValue("theme");
      expect(readUiValue("theme", "fallback")).toBe("fallback");
    });

    it("updates localStorage after removal", async () => {
      const { writeUiValue, removeUiValue, __resetUiStoreForTests } = await loadUiStore();
      __resetUiStoreForTests({ theme: "dark", other: "keep" });
      writeUiValue("theme", "dark");
      writeUiValue("other", "keep");
      removeUiValue("theme");
      const raw = localStorage.getItem(BACKUP_KEY);
      const parsed = JSON.parse(raw!);
      expect(parsed).toEqual({ other: "keep" });
      expect(parsed.theme).toBeUndefined();
    });
  });

  describe("Tauri mode (with native bridge)", () => {
    it("calls bridge.uiStoreRemoveKv with the key", async () => {
      const bridge = installBridge();
      const { removeUiValue, __resetUiStoreForTests } = await loadUiStore();
      __resetUiStoreForTests({ theme: "dark" });
      removeUiValue("theme");
      await flushMicrotasks();
      expect(bridge.uiStoreRemoveKv).toHaveBeenCalledWith({ key: "theme" });
    });

    it("does NOT write to localStorage when bridge is available", async () => {
      installBridge();
      const { removeUiValue, __resetUiStoreForTests } = await loadUiStore();
      __resetUiStoreForTests({ theme: "dark" });
      removeUiValue("theme");
      expect(localStorage.getItem(BACKUP_KEY)).toBeNull();
    });
  });
});

describe("initUiStore", () => {
  beforeEach(() => {
    // Each test needs a fresh module state; reset modules in each test.
  });

  describe("Web mode (no native bridge)", () => {
    it("loads from localStorage when bridge is unavailable and cache is empty", async () => {
      removeBridge();
      // Pre-populate localStorage before importing the module
      localStorage.setItem(BACKUP_KEY, JSON.stringify({ theme: "dark", scale: "lg" }));

      const { initUiStore, readUiValue } = await loadUiStore();
      await initUiStore();

      expect(readUiValue("theme", "light")).toBe("dark");
      expect(readUiValue("scale", "md")).toBe("lg");
    });

    it("falls back to defaults when localStorage is empty", async () => {
      removeBridge();
      localStorage.removeItem(BACKUP_KEY);

      const { initUiStore, readUiValue } = await loadUiStore();
      await initUiStore();

      expect(readUiValue("theme", "light")).toBe("light");
    });

    it("handles corrupted localStorage gracefully", async () => {
      removeBridge();
      localStorage.setItem(BACKUP_KEY, "{invalid json");

      const { initUiStore, readUiValue } = await loadUiStore();
      await initUiStore();

      // Should fall back to empty cache, return fallback
      expect(readUiValue("theme", "default")).toBe("default");
    });

    it("handles non-object JSON in localStorage gracefully", async () => {
      removeBridge();
      localStorage.setItem(BACKUP_KEY, JSON.stringify("just a string"));

      const { initUiStore, readUiValue } = await loadUiStore();
      await initUiStore();

      expect(readUiValue("theme", "default")).toBe("default");
    });
  });

  describe("Tauri mode (with native bridge)", () => {
    it("loads from the native bridge snapshot", async () => {
      const bridge = installBridge(fakeBridge({ kv: { theme: "dracula" } }));

      const { initUiStore, readUiValue } = await loadUiStore();
      await initUiStore();

      expect(readUiValue("theme", "light")).toBe("dracula");
      expect(bridge.uiStoreSnapshot).toHaveBeenCalledOnce();
    });

    it("does NOT read from localStorage when bridge is available", async () => {
      // Pre-populate localStorage (should be ignored when bridge exists)
      localStorage.setItem(BACKUP_KEY, JSON.stringify({ theme: "from-localStorage" }));
      installBridge(fakeBridge({ kv: { theme: "from-bridge" } }));

      const { initUiStore, readUiValue } = await loadUiStore();
      await initUiStore();

      // Bridge data takes precedence
      expect(readUiValue("theme", "light")).toBe("from-bridge");
    });

    it("falls back to defaults when bridge snapshot is empty", async () => {
      installBridge(EMPTY_SNAPSHOT);

      const { initUiStore, readUiValue } = await loadUiStore();
      await initUiStore();

      expect(readUiValue("theme", "light")).toBe("light");
    });
  });

  describe("idempotency", () => {
    it("only initializes once — second call returns the same promise", async () => {
      removeBridge();
      localStorage.setItem(BACKUP_KEY, JSON.stringify({ theme: "dark" }));

      const { initUiStore, readUiValue } = await loadUiStore();
      const p1 = initUiStore();
      const p2 = initUiStore();
      // Both calls should resolve with the same initialized cache
      await p1;
      await p2;
      expect(readUiValue("theme", "light")).toBe("dark");
    });

    it("reloadUiStore resets and re-initializes", async () => {
      removeBridge();
      localStorage.setItem(BACKUP_KEY, JSON.stringify({ theme: "dark" }));

      const { initUiStore, reloadUiStore, readUiValue } = await loadUiStore();
      await initUiStore();
      expect(readUiValue("theme", "light")).toBe("dark");

      // Change localStorage and reload
      localStorage.setItem(BACKUP_KEY, JSON.stringify({ theme: "light-modern" }));
      await reloadUiStore();

      expect(readUiValue("theme", "light")).toBe("light-modern");
    });
  });
});

describe("write → initUiStore round-trip (web mode)", () => {
  it("survives a simulated page refresh (module reset)", async () => {
    // First session: write values
    removeBridge();
    let mod = await loadUiStore();
    mod.__resetUiStoreForTests({});
    mod.writeUiValue("theme", "dark-modern");
    mod.writeUiValue("scale", "lg");

    // Verify in-memory
    expect(mod.readUiValue("theme", "light")).toBe("dark-modern");
    expect(mod.readUiValue("scale", "md")).toBe("lg");

    // Verify localStorage backup
    const raw = localStorage.getItem(BACKUP_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ theme: "dark-modern", scale: "lg" });

    // Second session: simulate page reload by resetting modules
    vi.resetModules();
    removeBridge();
    mod = await loadUiStore();
    await mod.initUiStore();

    // Values should have been restored from localStorage
    expect(mod.readUiValue("theme", "light")).toBe("dark-modern");
    expect(mod.readUiValue("scale", "md")).toBe("lg");
  });
});

describe("installGlobalUiStoreBridge (__HERMES_UI_STORE__)", () => {
  it("exposes readUiValue via get()", async () => {
    const { __resetUiStoreForTests } = await loadUiStore();
    __resetUiStoreForTests({ theme: "catppuccin-mocha" });
    expect((globalThis as any).__HERMES_UI_STORE__.get("theme", "light")).toBe("catppuccin-mocha");
  });

  it("exposes writeUiValue via set()", async () => {
    const { __resetUiStoreForTests } = await loadUiStore();
    __resetUiStoreForTests({});
    (globalThis as any).__HERMES_UI_STORE__.set("theme", "dark");
    expect((globalThis as any).__HERMES_UI_STORE__.get("theme", "light")).toBe("dark");
  });

  it("exposes removeUiValue via remove()", async () => {
    const { __resetUiStoreForTests } = await loadUiStore();
    __resetUiStoreForTests({ theme: "dark" });
    (globalThis as any).__HERMES_UI_STORE__.remove("theme");
    expect((globalThis as any).__HERMES_UI_STORE__.get("theme", "light")).toBe("light");
  });
});
