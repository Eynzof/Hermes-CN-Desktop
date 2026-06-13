export const MINIMUM_LOCAL_CONTEXT_LENGTH = 64_000;
export const RECOMMENDED_LOCAL_CONTEXT_LENGTH = 65_536;

export const HERMES_CONTEXT_REQUIREMENTS_URL =
  "https://hermesagent.org.cn/en/docs/getting-started/quickstart";
export const HERMES_PROVIDER_CONTEXT_URL =
  "https://hermes-agent.nousresearch.com/docs/integrations/providers";

export type LocalContextWarningSource = "configured" | "detected";

export interface LocalContextWarning {
  length: number;
  source: LocalContextWarningSource;
  message: string;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

export function parseLocalContextWindow(raw: string | number | null | undefined): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string" && !raw.trim()) return undefined;
  return positiveInteger(raw);
}

function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

export function getLocalContextWarning(input: {
  isLocalProvider: boolean;
  configuredContextWindow?: string | number | null;
  effectiveContextLength?: number | null;
}): LocalContextWarning | null {
  if (!input.isLocalProvider) return null;

  const configured = parseLocalContextWindow(input.configuredContextWindow);
  const detected = positiveInteger(input.effectiveContextLength);
  const length = configured ?? detected;
  if (length == null || length >= MINIMUM_LOCAL_CONTEXT_LENGTH) return null;

  const source: LocalContextWarningSource = configured != null ? "configured" : "detected";
  const sourceText = source === "configured" ? "当前填写" : "当前探测";
  return {
    length,
    source,
    message: `${sourceText}上下文约 ${formatTokens(length)} tokens，低于 Hermes 要求的 ${formatTokens(MINIMUM_LOCAL_CONTEXT_LENGTH)}。建议将本地运行时和桌面端覆盖都设为 ${formatTokens(RECOMMENDED_LOCAL_CONTEXT_LENGTH)}，否则启动或运行时可能被拒绝。`,
  };
}
