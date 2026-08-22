/**
 * React hooks and Jotai state for the in-process plugin registry.
 *
 * Keeps a single `PluginManager` instance in a jotai atom. The `version` field
 * is bumped whenever the registry is mutated so derived atoms and components
 * re-render without mutating the service reference.
 */

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { atom } from "jotai";
import { useCallback, useMemo } from "react";
import {
  PluginRegistry,
  type PluginDiscoveryResult,
  type PluginKind,
  type PluginManifest,
  type PluginRecord,
  type PluginSummary,
} from "@hermes/agent-core";

export interface PluginManagerState {
  registry: PluginRegistry;
  version: number;
  isLoading: boolean;
  error: string | null;
  lastDiscovery: PluginDiscoveryResult | null;
}

export const pluginManagerAtom = atom<PluginManagerState>({
  registry: new PluginRegistry(),
  version: 0,
  isLoading: false,
  error: null,
  lastDiscovery: null,
});

/** Derived atom exposing the sorted plugin summary list. */
export const pluginListAtom = atom((get) => {
  const { registry, version } = get(pluginManagerAtom);
  void version;
  return registry.summaries();
});

/** Derived atom exposing plugins grouped by kind. */
export const pluginsByKindAtom = atom((get) => {
  const { registry, version } = get(pluginManagerAtom);
  void version;
  const kinds: PluginKind[] = ["general", "model-provider", "memory-provider", "context-engine"];
  return kinds.map((kind) => ({
    kind,
    plugins: registry.byKind(kind).map((record) => record.manifest),
  }));
});

/** Derived atom exposing the count of enabled plugins. */
export const enabledPluginCountAtom = atom((get) => {
  const { registry, version } = get(pluginManagerAtom);
  void version;
  return registry.list().filter((p) => p.enabled).length;
});

function bumpVersion(state: PluginManagerState): PluginManagerState {
  return { ...state, version: state.version + 1, error: null };
}

/** Discover plugins from manifests and bump the store version. */
export const discoverPluginsAtom = atom(
  null,
  (get, set, manifests: PluginManifest[], source: PluginRecord["source"] = "local") => {
    const state = get(pluginManagerAtom);
    const result = state.registry.discover(manifests, source);
    set(pluginManagerAtom, { ...bumpVersion(state), lastDiscovery: result });
    return result;
  },
);

/** Register a single plugin and bump the store version. */
export const registerPluginAtom = atom(
  null,
  (get, set, manifest: PluginManifest, source: PluginRecord["source"] = "local") => {
    const state = get(pluginManagerAtom);
    state.registry.register(manifest, source);
    set(pluginManagerAtom, bumpVersion(state));
  },
);

/** Enable a plugin by id and bump the store version. */
export const enablePluginAtom = atom(null, (get, set, id: string) => {
  const state = get(pluginManagerAtom);
  state.registry.enable(id);
  set(pluginManagerAtom, bumpVersion(state));
});

/** Disable a plugin by id and bump the store version. */
export const disablePluginAtom = atom(null, (get, set, id: string) => {
  const state = get(pluginManagerAtom);
  state.registry.disable(id);
  set(pluginManagerAtom, bumpVersion(state));
});

/** Remove a plugin by id and bump the store version. */
export const removePluginAtom = atom(null, async (get, set, id: string) => {
  const state = get(pluginManagerAtom);
  await state.registry.remove(id);
  set(pluginManagerAtom, bumpVersion(state));
});

/** Reload a plugin manifest and bump the store version. */
export const reloadPluginAtom = atom(null, (get, set, id: string, manifest: PluginManifest) => {
  const state = get(pluginManagerAtom);
  state.registry.reload(id, manifest);
  set(pluginManagerAtom, bumpVersion(state));
});

/** Set loading/error state. */
export const setPluginManagerStatusAtom = atom(
  null,
  (get, set, update: Partial<Pick<PluginManagerState, "isLoading" | "error">>) => {
    const state = get(pluginManagerAtom);
    set(pluginManagerAtom, { ...state, ...update });
  },
);

/** Hook exposing the plugin list and mutation helpers. */
export function usePlugins() {
  const list = useAtomValue(pluginListAtom);
  const byKind = useAtomValue(pluginsByKindAtom);
  const enabledCount = useAtomValue(enabledPluginCountAtom);
  const [state] = useAtom(pluginManagerAtom);
  const discover = useSetAtom(discoverPluginsAtom);
  const register = useSetAtom(registerPluginAtom);
  const enable = useSetAtom(enablePluginAtom);
  const disable = useSetAtom(disablePluginAtom);
  const remove = useSetAtom(removePluginAtom);
  const reload = useSetAtom(reloadPluginAtom);
  const setStatus = useSetAtom(setPluginManagerStatusAtom);

  return useMemo(
    () => ({
      plugins: list,
      byKind,
      enabledCount,
      isLoading: state.isLoading,
      error: state.error,
      lastDiscovery: state.lastDiscovery,
      registry: state.registry,
      discover,
      register,
      enable,
      disable,
      remove,
      reload,
      setStatus,
    }),
    [
      list,
      byKind,
      enabledCount,
      state.isLoading,
      state.error,
      state.lastDiscovery,
      state.registry,
      discover,
      register,
      enable,
      disable,
      remove,
      reload,
      setStatus,
    ],
  );
}

/** Hook for a single plugin record by id. */
export function usePlugin(id: string | undefined) {
  const { registry } = usePlugins();
  return useMemo(() => {
    if (!id) return undefined;
    return registry.get(id);
  }, [registry, id]);
}

/** Hook returning plugins of a specific kind. */
export function usePluginsByKind(kind: PluginKind) {
  const { registry } = usePlugins();
  return useMemo(() => registry.byKind(kind), [registry, kind]);
}

/** Hook returning callbacks to enable/disable a plugin. */
export function usePluginToggle(id: string | undefined) {
  const { enable, disable, plugins } = usePlugins();
  const summary = useMemo(
    () => plugins.find((p) => p.id === id),
    [plugins, id],
  );

  const toggle = useCallback(() => {
    if (!id || !summary) return;
    if (summary.enabled) {
      disable(id);
    } else {
      enable(id);
    }
  }, [id, summary, enable, disable]);

  return { enabled: summary?.enabled ?? false, toggle };
}
