import type { PluginHubRow } from "@hermes/protocol";

export type PluginEffectiveStatus =
  | "enabled"
  | "auto-active"
  | "inactive"
  | "disabled"
  | "provider-managed";

export interface PluginFilters {
  query: string;
  source: string;
  kind: string;
  status: string;
}

export interface PluginSummary {
  total: number;
  active: number;
  inactive: number;
  disabled: number;
  providerManaged: number;
}

const EFFECTIVE_STATUSES = new Set<PluginEffectiveStatus>([
  "enabled",
  "auto-active",
  "inactive",
  "disabled",
  "provider-managed",
]);

export function pluginEffectiveStatus(plugin: PluginHubRow): PluginEffectiveStatus {
  const effective = plugin.effective_status as PluginEffectiveStatus | undefined;
  if (effective && EFFECTIVE_STATUSES.has(effective)) return effective;
  if (plugin.can_toggle === false || plugin.kind === "exclusive" || plugin.kind === "model-provider") {
    return "provider-managed";
  }
  if (plugin.runtime_status === "enabled") return "enabled";
  if (plugin.runtime_status === "disabled") return "disabled";
  return "inactive";
}

export function pluginCanToggle(plugin: PluginHubRow): boolean {
  if (plugin.can_toggle !== undefined) return plugin.can_toggle;
  return plugin.kind !== "exclusive" && plugin.kind !== "model-provider";
}

export function summarizePlugins(plugins: readonly PluginHubRow[]): PluginSummary {
  return plugins.reduce<PluginSummary>((summary, plugin) => {
    const status = pluginEffectiveStatus(plugin);
    summary.total += 1;
    if (status === "enabled" || status === "auto-active") summary.active += 1;
    else if (status === "inactive") summary.inactive += 1;
    else if (status === "disabled") summary.disabled += 1;
    else summary.providerManaged += 1;
    return summary;
  }, { total: 0, active: 0, inactive: 0, disabled: 0, providerManaged: 0 });
}

export function filterPlugins(
  plugins: readonly PluginHubRow[],
  filters: PluginFilters,
): PluginHubRow[] {
  const query = filters.query.trim().toLowerCase();
  return plugins.filter((plugin) => {
    if (filters.source !== "all" && plugin.source !== filters.source) return false;
    if (filters.kind !== "all" && plugin.kind !== filters.kind) return false;
    if (filters.status !== "all" && pluginEffectiveStatus(plugin) !== filters.status) return false;
    if (!query) return true;
    const haystack = [
      plugin.name,
      plugin.key,
      plugin.description,
      plugin.author,
      plugin.source,
      plugin.kind,
      ...plugin.provides_tools,
      ...plugin.provides_hooks,
      ...plugin.requires_env,
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

export function pluginStatusLabel(status: PluginEffectiveStatus): string {
  if (status === "enabled") return "已启用";
  if (status === "auto-active") return "自动生效";
  if (status === "disabled") return "已禁用";
  if (status === "provider-managed") return "Provider 管理";
  return "未启用";
}

export function pluginSourceLabel(source: string): string {
  if (source === "bundled") return "内置";
  if (source === "user") return "用户";
  if (source === "git") return "Git";
  if (source === "project") return "项目";
  if (source === "entrypoint") return "Python 包";
  return source || "未知";
}

export function pluginKindLabel(kind: string): string {
  if (kind === "standalone") return "独立插件";
  if (kind === "backend") return "能力后端";
  if (kind === "exclusive") return "独占 Provider";
  if (kind === "platform") return "消息平台";
  if (kind === "model-provider") return "模型 Provider";
  return kind || "未知类型";
}
