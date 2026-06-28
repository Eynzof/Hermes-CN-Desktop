/**
 * Friendly parsing for gateway RPC results.
 *
 * If an RPC result is shaped unexpectedly (runtime version skew, error frame,
 * missing field) the call sites in `use-gateway.ts` used to do a bare
 * `Schema.parse(...)` and the raw `ZodError` — e.g. the infamous
 * `[{"path":["session_id"],"message":"Required"}]` — leaked straight into the
 * chat UI.
 *
 * `parseGatewayResult` keeps the strong typing but converts a parse failure
 * into a user-readable Chinese message while recording a redacted debug summary
 * (method + raw result + zod issues) for diagnostics. `humanizeGatewayError`
 * is the display-boundary fallback so no raw ZodError / English transport error
 * ever reaches the user.
 */
import { debugBus } from "./debug-bus";

/** Error carrying a user-facing (Chinese) message; raw cause is in debugBus. */
export class GatewayResultError extends Error {
  readonly method: string;

  constructor(message: string, method: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "GatewayResultError";
    this.method = method;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

interface ZodLikeError {
  name: string;
  issues: unknown[];
  message: string;
}

function isZodError(error: unknown): error is ZodLikeError {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

function genericResultMessage(method: string): string {
  return `内核返回了无法识别的响应（${method}）。可能是版本不一致或连接异常，请重试；若仍失败，请重启 Hermes。`;
}

/**
 * Validate a gateway RPC result against `schema`. On success returns the parsed
 * value (same type as `schema.parse`). On failure, records a redacted debug
 * summary and throws a friendly {@link GatewayResultError} instead of leaking
 * the raw ZodError to the UI.
 */
export function parseGatewayResult<T>(
  schema: { parse: (value: unknown) => T },
  raw: unknown,
  method: string,
): T {
  try {
    return schema.parse(raw);
  } catch (error) {
    debugBus.push({
      type: "gateway",
      level: "error",
      summary: `RPC ${method} 响应解析失败`,
      payload: {
        method,
        raw,
        issues: isZodError(error) ? error.issues : undefined,
      },
    });
    throw new GatewayResultError(genericResultMessage(method), method, { cause: error });
  }
}

/**
 * Convert any gateway/transport error into a user-facing Chinese string. Used by
 * the chat error display so users never see a raw Zod validation blob or an
 * untranslated transport error. Raw ZodError details are logged to debugBus.
 */
export function humanizeGatewayError(error: unknown): string {
  if (error instanceof GatewayResultError) return error.message;

  if (isZodError(error)) {
    debugBus.push({
      type: "gateway",
      level: "error",
      summary: "Gateway 响应解析失败（ZodError）",
      payload: { issues: error.issues },
    });
    return "内核返回了无法识别的响应，请重试；若仍失败，请重启 Hermes。";
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message) return "发生错误，请重试。";

  const lower = message.toLowerCase();
  if (lower.includes("timeout") || message.includes("超时")) {
    return "请求超时，请重试。若使用本地模型（如 LM Studio、Ollama），请确认本地服务已启动、模型已加载，且上下文窗口足够大。";
  }
  if (
    lower.includes("connection closed") ||
    lower.includes("connection lost") ||
    lower.includes("websocket closed") ||
    lower.includes("disconnect")
  ) {
    return "与内核的连接已断开，正在重新连接。";
  }
  return message;
}
