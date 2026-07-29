import type {
  MemoryProviderRuntimeStatusResponse,
  MemoryProviderConfigField,
} from "@hermes/protocol";
import type { VisibleMemoryProvider } from "@/hooks/use-memory";

export const MEMORY_BACKEND_META: Record<VisibleMemoryProvider, {
  label: string;
  description: string;
  offlineHint: string;
}> = {
  openviking: {
    label: "OpenViking",
    description: "本地或远程上下文数据库，提供分层召回、记忆提取与可观测组件。",
    offlineHint: "请确认 OpenViking 服务已在 Endpoint 启动。Hermes 只连接和监控，不会代为启停进程。",
  },
  hindsight: {
    label: "Hindsight",
    description: "基于事实、文档、观察与知识图谱的长期记忆后端。",
    offlineHint: "请确认 Hindsight API 已启动并可从本机访问。Hermes 不接管 Hindsight 服务进程。",
  },
};

const ADVANCED_FIELDS: Record<VisibleMemoryProvider, Set<string>> = {
  openviking: new Set([
    "recall_limit",
    "recall_score_threshold",
    "recall_max_injected_chars",
    "recall_timeout_seconds",
    "recall_request_timeout_seconds",
    "recall_full_read_limit",
    "recall_prefer_abstract",
    "recall_resources",
    "use_ovcli_config",
    "ovcli_config_path",
  ]),
  hindsight: new Set([
    "bank_id_template",
    "bank_mission",
    "bank_retain_mission",
    "recall_budget",
    "memory_mode",
    "recall_prefetch_method",
    "retain_tags",
    "observation_scopes",
    "retain_source",
    "retain_user_prefix",
    "retain_assistant_prefix",
    "recall_tags",
    "recall_tags_match",
    "recall_types",
    "auto_recall",
    "auto_retain",
    "retain_every_n_turns",
    "retain_async",
    "retain_context",
    "recall_max_tokens",
    "recall_max_input_chars",
    "recall_prompt_preamble",
    "timeout",
    "idle_timeout",
    "port_health_grace_timeout",
    "llm_provider",
    "llm_base_url",
    "llm_api_key",
    "llm_model",
  ]),
};

export function isAdvancedMemoryField(provider: VisibleMemoryProvider, key: string): boolean {
  return ADVANCED_FIELDS[provider].has(key);
}

export function isMemoryFieldVisible(
  field: MemoryProviderConfigField,
  values: Record<string, unknown>,
): boolean {
  if (!field.when) return true;
  return Object.entries(field.when).every(([key, expected]) => String(values[key] ?? "") === String(expected));
}

export function memoryBackendState(status?: MemoryProviderRuntimeStatusResponse): {
  label: "未配置" | "已保存但离线" | "在线可用" | "当前启用" | "运行异常";
  tone: "muted" | "warn" | "ok" | "active" | "error";
} {
  if (!status?.configured) return { label: "未配置", tone: "muted" };
  if (!status.reachable) return { label: "已保存但离线", tone: "warn" };
  if (!status.healthy) return { label: "运行异常", tone: "error" };
  if (status.active) return { label: "当前启用", tone: "active" };
  return { label: "在线可用", tone: "ok" };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function numericValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function formatCheckedAt(value?: string): string {
  if (!value) return "尚未检查";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function humanizeKey(key: string): string {
  const labels: Record<string, string> = {
    endpoint: "Endpoint",
    api_key: "API Key",
    account: "Account",
    user: "User",
    agent: "Agent",
    mode: "Mode",
    api_url: "API URL",
    bank_id: "Bank ID",
    dashboard_url: "Dashboard URL",
    recall_budget: "召回预算",
    bank_mission: "Bank Mission",
    bank_retain_mission: "Retain Mission",
  };
  return labels[key] ?? key.replaceAll("_", " ");
}

export function compactHealthDetail(value: unknown, healthy: boolean): string {
  if (typeof value !== "string" || !value.trim()) return healthy ? "正常" : "异常";
  const detail = value.trim();
  if (detail.length > 48 || detail.includes("\n") || detail.includes("+---")) {
    return healthy ? "正常" : "异常";
  }
  return detail;
}
