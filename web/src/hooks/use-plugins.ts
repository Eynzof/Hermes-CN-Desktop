import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PluginActionResponse,
  PluginInstallResponse,
  PluginsHubResponse,
  type PluginHubRow,
} from "@hermes/protocol";
import { deleteJSON, fetchJSON, postJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";

export const PLUGINS_QUERY_KEY = "plugins-hub";

export function pluginPath(key: string): string {
  return key
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function pluginActionPath(
  key: string,
  action: "enable" | "disable" | "update",
): string {
  return `/api/dashboard/agent-plugins/${pluginPath(key)}/${action}`;
}

export function pluginRemovePath(key: string): string {
  return `/api/dashboard/agent-plugins/${pluginPath(key)}`;
}

export function usePluginsHub() {
  const profile = useActiveProfileName();
  return useQuery({
    queryKey: [PLUGINS_QUERY_KEY, profile],
    queryFn: ({ signal }) =>
      fetchJSON("/api/dashboard/plugins/hub", { signal }, PluginsHubResponse),
    staleTime: 30_000,
  });
}

export interface InstallPluginInput {
  identifier: string;
  force?: boolean;
  enable?: boolean;
}

export function useInstallPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ identifier, force = false, enable = true }: InstallPluginInput) =>
      postJSON(
        "/api/dashboard/agent-plugins/install",
        { identifier, force, enable },
        PluginInstallResponse,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [PLUGINS_QUERY_KEY] }),
  });
}

export interface SetPluginEnabledInput {
  plugin: PluginHubRow;
  enabled: boolean;
}

export function useSetPluginEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ plugin, enabled }: SetPluginEnabledInput) => {
      const key = plugin.key || plugin.name;
      return postJSON(
        pluginActionPath(key, enabled ? "enable" : "disable"),
        {},
        PluginActionResponse,
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [PLUGINS_QUERY_KEY] }),
  });
}

export function useUpdatePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plugin: PluginHubRow) =>
      postJSON(
        pluginActionPath(plugin.key || plugin.name, "update"),
        {},
        PluginActionResponse,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [PLUGINS_QUERY_KEY] }),
  });
}

export function useRemovePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plugin: PluginHubRow) =>
      deleteJSON(
        pluginRemovePath(plugin.key || plugin.name),
        undefined,
        PluginActionResponse,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [PLUGINS_QUERY_KEY] }),
  });
}
