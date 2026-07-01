import { LogsResponse } from "@hermes/protocol";
import type { GatewayEvent } from "@hermes/protocol";
import { debugBus, type DebugEntryLevel } from "./debug-bus";
import { getGatewayClient } from "./gateway-client";
import { fetchJSON } from "./transport";

let installed = false;
let logTailInstalled = false;
let stopBackendLogTail: (() => void) | null = null;

const LOG_TAIL_FILES = ["errors", "agent", "gateway"] as const;
const LOG_TAIL_INTERVAL_MS = 3000;
const LOG_TAIL_LINES = 50;
const BENIGN_CONSOLE_WARNINGS = [
  "IPC custom protocol failed, Tauri will now use the postMessage interface instead",
] as const;
const lastSeenLogLine: Partial<Record<string, string>> = {};

function classifyLogLine(line: string): DebugEntryLevel {
  const upper = line.toUpperCase();
  if (upper.includes("ERROR") || upper.includes("CRITICAL") || upper.includes("FATAL")) return "error";
  if (upper.includes("WARNING") || upper.includes("WARN")) return "warn";
  return "info";
}

async function pollBackendLogFile(file: string): Promise<void> {
  let data: { file: string; lines: string[] };
  try {
    const params = new URLSearchParams({ file, lines: String(LOG_TAIL_LINES) });
    data = await fetchJSON(`/api/logs?${params.toString()}`, undefined, LogsResponse);
  } catch {
    return;
  }
  const lines = (data.lines ?? [])
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return;

  const previous = lastSeenLogLine[file];
  const last = lines[lines.length - 1]!;

  let toPush: string[];
  if (previous === undefined) {
    toPush = [];
  } else {
    const idx = lines.lastIndexOf(previous);
    toPush = idx >= 0 ? lines.slice(idx + 1) : lines;
  }
  lastSeenLogLine[file] = last;

  for (const line of toPush) {
    debugBus.push({
      type: "backend",
      level: classifyLogLine(line),
      summary: `[${file}] ${line.slice(0, 280)}`,
      payload: { file, line },
    });
  }
}

function startBackendLogTail(): () => void {
  if (logTailInstalled) return stopBackendLogTail ?? (() => {});
  logTailInstalled = true;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    if (typeof document !== "undefined" && document.hidden) return;
    await Promise.all(LOG_TAIL_FILES.map(pollBackendLogFile));
  };

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void tick().finally(() => schedule(LOG_TAIL_INTERVAL_MS));
    }, delay);
  };

  stopBackendLogTail = () => {
    stopped = true;
    logTailInstalled = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    stopBackendLogTail = null;
  };

  schedule(1500);
  return stopBackendLogTail;
}

function summarizeArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg === null) return "null";
      if (arg === undefined) return "undefined";
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function isBenignConsoleWarning(summary: string): boolean {
  return BENIGN_CONSOLE_WARNINGS.some((message) => summary.includes(message));
}

type DebugPushEntry = Parameters<typeof debugBus.push>[0];

function gatewayPayloadObject(event: GatewayEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object"
    ? event.payload as Record<string, unknown>
    : {};
}

function gatewayPayloadText(payload: Record<string, unknown>): string | undefined {
  for (const key of ["message", "error", "detail", "reason", "text", "code"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function hasGatewayErrorDetails(payload: Record<string, unknown>): boolean {
  if (gatewayPayloadText(payload)) return true;
  return Object.entries(payload).some(([key, value]) => {
    if (key === "status" || key === "ok") return false;
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim().length > 0;
    return true;
  });
}

export function gatewayDebugEntryForEvent(event: GatewayEvent): DebugPushEntry | null {
  const eventType = typeof event.type === "string" ? event.type : "unknown";
  const payloadObj = gatewayPayloadObject(event);
  if (eventType === "error" && !hasGatewayErrorDetails(payloadObj)) return null;

  const isError =
    eventType === "error" ||
    eventType === "gateway.disconnected" ||
    payloadObj.status === "error";
  const payloadText = gatewayPayloadText(payloadObj);
  const sidText = event.session_id ? ` · sid=${String(event.session_id).slice(0, 8)}` : "";
  const detailText = payloadText ? ` · ${payloadText.slice(0, 160)}` : "";
  return {
    type: "gateway",
    level: isError ? "error" : "info",
    summary: `${eventType}${sidText}${detailText}`,
    payload: event,
  };
}

export function installDebugCapture(): void {
  if (installed) return;
  // Skip in vitest / jsdom — patching console.error/warn breaks vi.spyOn(console, "error")
  // assertions used by other tests, and gateway/log polling are pointless without a server.
  if (typeof import.meta !== "undefined" && (import.meta as any).env?.MODE === "test") return;
  installed = true;

  // 1. Gateway events
  try {
    getGatewayClient().onAny((event) => {
      const entry = gatewayDebugEntryForEvent(event);
      if (entry) debugBus.push(entry);
    });
  } catch {
    // gateway client may not be ready yet; OK to skip
  }

  // 2. Console intercept (errors and warnings only)
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    debugBus.push({
      type: "console",
      level: "error",
      summary: summarizeArgs(args).slice(0, 500),
      payload: args.length === 1 ? args[0] : args,
    });
    originalError.apply(console, args);
  };
  console.warn = (...args: unknown[]) => {
    const summary = summarizeArgs(args).slice(0, 500);
    if (!isBenignConsoleWarning(summary)) {
      debugBus.push({
        type: "console",
        level: "warn",
        summary,
        payload: args.length === 1 ? args[0] : args,
      });
    }
    originalWarn.apply(console, args);
  };

  // 3. Window-level errors
  if (typeof window !== "undefined") {
    window.addEventListener("error", (event) => {
      debugBus.push({
        type: "exception",
        level: "error",
        summary: event.message || String(event.error ?? "Uncaught error"),
        payload: {
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error instanceof Error ? event.error.stack : undefined,
        },
      });
    });

    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      debugBus.push({
        type: "exception",
        level: "error",
        summary:
          reason instanceof Error
            ? `Unhandled rejection: ${reason.message}`
            : `Unhandled rejection: ${summarizeArgs([reason]).slice(0, 200)}`,
        payload: reason instanceof Error
          ? { message: reason.message, stack: reason.stack }
          : reason,
      });
    });
  }

  // 4. Backend log tail (~/.hermes/logs/{errors,agent,gateway}.log)
  const stopLogTail = startBackendLogTail();
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", stopLogTail, { once: true });
  }
}
