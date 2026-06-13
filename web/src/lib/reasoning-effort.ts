// 思考强度（Reasoning Effort）——与后端 Hermes-CN-Core 的事实来源对齐。
//
// 后端常量 `VALID_REASONING_EFFORTS = ("minimal", "low", "medium", "high",
// "xhigh")`（hermes_constants.py），外加特殊值 "none" 表示关闭推理
// （parse_reasoning_effort("none") → {"enabled": False}）。
// 配置落在 config.yaml 的 `agent.reasoning_effort`；网关 `config.set`
// （key="reasoning"）会把字面字符串写进该字段，因此这里直接复用同一组取值。

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

// 下拉菜单里的完整中文标签。
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "关闭思考",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

// 工具栏 trigger 上的紧凑标签（"关闭思考" 在 trigger 里显得啰嗦）。
export const REASONING_EFFORT_SHORT_LABELS: Record<ReasoningEffort, string> = {
  none: "关闭",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

// 后端在 `agent.reasoning_effort` 为空时的默认取值（tui_gateway/server.py
// 的 config.get 对 key="reasoning" 回落到 "medium"）。仅用于向用户说明
// "未显式设置时实际会用哪一档"，不代表配置里真的写了这个值。
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

/** 是否为合法的思考强度取值。 */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/**
 * 把后端/配置里读到的任意值规整成合法的思考强度。
 * 大小写不敏感、去空白；无法识别（含空串）返回 null，表示"未显式设置"。
 */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isReasoningEffort(normalized) ? normalized : null;
}

/**
 * 从 `/api/config` 返回的完整配置里取出 `agent.reasoning_effort`。
 * 读不到或非法时返回 null（调用方据此回落到后端默认）。
 */
export function reasoningEffortFromConfig(
  config: Record<string, unknown> | undefined | null,
): ReasoningEffort | null {
  if (!config || typeof config !== "object") return null;
  const agent = (config as Record<string, unknown>)["agent"];
  if (!agent || typeof agent !== "object") return null;
  return normalizeReasoningEffort(
    (agent as Record<string, unknown>)["reasoning_effort"],
  );
}
