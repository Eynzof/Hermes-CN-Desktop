/**
 * Tool-call dispatcher.
 *
 * `handleToolCall(name, args, ctx)` routes to a native TS handler when one is
 * registered; otherwise it falls back to a Rust IPC command. This matches the
 * migration path in the plan: OS-level tools stay in Rust while pure-logic /
 * HTTP tools run natively in TS.
 */

import "./catalog.js";
import { registry } from "./registry.js";
import type { ToolCallOutcome, ToolContext, ToolResult } from "./types.js";

export type { ToolCallOutcome, ToolResult };

export interface DispatchOptions {
  /** Invoker for Rust IPC fallback: command name + args → result JSON string. */
  invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Called on native handler success/error for observability. */
  onComplete?: (outcome: ToolCallOutcome) => void;
}

/** Tools that are always routed to Rust IPC because they need OS capabilities. */
const RUST_IPC_TOOLS = new Set([
  "file_read",
  "file_write",
  "file_search",
  "file_grep",
  "file_list",
  "terminal_run",
  "terminal_status",
  "process_start",
  "process_stop",
  "desktop_pick_file",
  "desktop_preview",
]);

/**
 * Execute a single tool call.
 *
 * - If `forceNative` is true, the native handler is used even for OS-level tools
 *   (useful for tests).
 * - If a native handler exists and the tool is NOT in the Rust IPC allowlist, it
 *   runs in-process.
 * - Otherwise, calls `tools_dispatch` on the Rust side via the supplied invoker.
 */
export async function handleToolCall(
  name: string,
  args: unknown,
  ctx: ToolContext,
  opts?: DispatchOptions & { forceNative?: boolean },
): Promise<ToolCallOutcome> {
  const startedAt = performance.now();
  const entry = registry.get(name);
  let result: ToolResult;

  if (entry && (opts?.forceNative || !RUST_IPC_TOOLS.has(name))) {
    const ctxWithInvoke = opts?.invoke ? { ...ctx, invoke: opts.invoke } : ctx;
    result = await registry.dispatch(name, args, ctxWithInvoke);
  } else if (opts?.invoke) {
    try {
      const raw = await opts.invoke("tools_dispatch", { name, args, sessionId: ctx.sessionId });
      result = normalizeRustResult(raw);
    } catch (err) {
      result = {
        content: `Rust IPC fallback failed for ${name}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  } else {
    result = {
      content: `Tool "${name}" requires a native capability that is not available in this context.`,
      isError: true,
    };
  }

  const outcome: ToolCallOutcome = {
    name,
    arguments: args,
    result,
    durationMs: Math.round(performance.now() - startedAt),
  };
  opts?.onComplete?.(outcome);
  return outcome;
}

function normalizeRustResult(raw: unknown): ToolResult {
  if (raw === null || raw === undefined) return { content: "" };
  if (typeof raw === "string") return { content: raw };
  if (typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (typeof r.content === "string") {
      return {
        content: r.content,
        isError: r.isError === true,
      };
    }
  }
  return { content: JSON.stringify(raw) };
}
