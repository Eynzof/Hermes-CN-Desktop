// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createStore, Provider } from "jotai";
import { useAtomValue } from "jotai";
import { renderHook, act } from "@testing-library/react";
import type { PluginManifest } from "@hermes/agent-core";
import {
  disablePluginAtom,
  discoverPluginsAtom,
  enablePluginAtom,
  pluginListAtom,
  pluginManagerAtom,
  registerPluginAtom,
  removePluginAtom,
  usePlugins,
} from "./plugins";

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "test-plugin",
    version: "1.0.0",
    kind: "general",
    ...overrides,
  };
}

function freshState() {
  return {
    registry: { clear: () => {} } as unknown as ReturnType<typeof usePlugins>["registry"],
    version: 0,
    isLoading: false,
    error: null,
    lastDiscovery: null,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <Provider>{children}</Provider>;
}

describe("pluginManagerAtom", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
    store.set(pluginManagerAtom, {
      registry: store.get(pluginManagerAtom).registry,
      version: 0,
      isLoading: false,
      error: null,
      lastDiscovery: null,
    });
    store.get(pluginManagerAtom).registry.clear();
  });

  it("starts empty", () => {
    const { result } = renderHook(() => usePlugins(), { wrapper });
    expect(result.current.plugins).toHaveLength(0);
    expect(result.current.enabledCount).toBe(0);
  });

  it("registers a plugin and reflects it in the list", () => {
    const { result } = renderHook(() => usePlugins(), { wrapper });

    act(() => {
      result.current.register(makeManifest({ name: "demo", title: "Demo Plugin" }));
    });

    expect(result.current.plugins).toHaveLength(1);
    expect(result.current.plugins[0]?.name).toBe("demo");
    expect(result.current.plugins[0]?.title).toBe("Demo Plugin");
  });

  it("enables and disables a plugin", () => {
    const { result } = renderHook(() => usePlugins(), { wrapper });

    act(() => {
      result.current.register(makeManifest({ name: "toggle" }));
    });

    act(() => {
      result.current.enable("toggle");
    });
    expect(result.current.plugins[0]?.enabled).toBe(true);

    act(() => {
      result.current.disable("toggle");
    });
    expect(result.current.plugins[0]?.enabled).toBe(false);
  });

  it("discovers multiple plugins", () => {
    const { result } = renderHook(() => usePlugins(), { wrapper });

    act(() => {
      result.current.discover([
        makeManifest({ name: "a" }),
        makeManifest({ name: "b" }),
      ]);
    });

    expect(result.current.plugins).toHaveLength(2);
  });

  it("removes a plugin", async () => {
    const { result } = renderHook(() => usePlugins(), { wrapper });

    act(() => {
      result.current.register(makeManifest({ name: "remove-me" }));
    });

    await act(async () => {
      await result.current.remove("remove-me");
    });

    expect(result.current.plugins).toHaveLength(0);
  });

  it("can be read with useAtomValue", () => {
    const { result } = renderHook(() => useAtomValue(pluginManagerAtom), { wrapper });
    expect(result.current.registry).toBeDefined();
    expect(result.current.version).toBe(0);
  });
});
