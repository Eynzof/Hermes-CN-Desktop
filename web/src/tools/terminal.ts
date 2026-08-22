/**
 * In-process `terminal` tool adapter.
 *
 * Exposes the same JSON surface as Python's `TERMINAL_SCHEMA` but routes to the
 * local TerminalManager/WaitService instead of the WS gateway.
 */
import { getTerminalManager, createTerminalManager } from "@/services/terminal/terminalManager";
import { terminalWaitService } from "@/services/terminal/waitService";
import { exportOutput } from "@/services/terminal/export";
import { buildPromotedToolResult, promoteSession } from "@/services/terminal/promotion";
import type {
  TerminalMode,
  TerminalStartOptions,
  TerminalToolResult,
} from "@/services/terminal/types";
import { FOREGROUND_MAX_TIMEOUT_MS } from "@/services/terminal/types";

export interface TerminalToolInput {
  command?: string;
  mode?: TerminalMode | string;
  interactive?: boolean;
  background?: boolean;
  timeout?: number;
  wait_for_pattern?: string;
  inactivity_timeout?: number;
  promote_on_timeout?: boolean;
  workdir?: string;
  cwd?: string;
  notify_on_complete?: boolean;
  max_lines?: number;
  pty?: boolean;
}

function normalizeMode(mode?: TerminalMode | string): TerminalStartOptions["mode"] {
  if (!mode) return "run";
  const m = String(mode).toLowerCase();
  if (["run", "execute", "foreground", "fg"].includes(m)) return "run";
  if (["background", "bg", "async", "detach"].includes(m)) return "background";
  if (["interactive", "repl", "shell"].includes(m)) return "interactive";
  return "run";
}

function clampTimeout(seconds?: number): number {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return FOREGROUND_MAX_TIMEOUT_MS / 1000;
  return Math.min(seconds, FOREGROUND_MAX_TIMEOUT_MS / 1000);
}

export async function terminalTool(input: TerminalToolInput): Promise<TerminalToolResult> {
  let manager = getTerminalManager();
  if (!manager) {
    manager = createTerminalManager();
  }

  const mode = normalizeMode(input.mode);
  const background = input.background ?? mode === "background";
  const command = input.command;
  const cwd = input.workdir ?? input.cwd;
  const timeoutSeconds = clampTimeout(input.timeout);
  const waitForPattern = input.wait_for_pattern;
  const inactivitySeconds = input.inactivity_timeout;
  const promoteOnTimeout = input.promote_on_timeout ?? false;

  const sessionId = await manager.start({
    command,
    cwd,
    mode,
    interactive: input.interactive ?? mode === "interactive",
    background,
    timeout: timeoutSeconds,
    waitForPattern,
    inactivityTimeout: inactivitySeconds,
  });

  const startedAt = Date.now();

  if (background) {
    return {
      status: "ok",
      session_id: sessionId,
      output: "",
      elapsed_seconds: 0,
    };
  }

  // Foreground: wait for pattern/exit/timeout.
  const waitResult = await terminalWaitService.wait(
    manager.get(sessionId)!,
    {
      timeout: timeoutSeconds,
      pattern: waitForPattern,
      inactivityTimeout: inactivitySeconds,
    },
  );

  const elapsed = (Date.now() - startedAt) / 1000;

  if (waitResult.status === "matched") {
    if (promoteOnTimeout) {
      const promoted = promoteSession(manager, sessionId);
      promoted.pattern_matched = true;
      promoted.matched_pattern = waitResult.matchedPattern;
      promoted.elapsed_seconds = elapsed;
      return buildPromotedToolResult(
        promoted,
        waitResult.output,
        waitResult.totalChars,
        manager.get(sessionId)?.bufferOverflowed ?? false,
      );
    }
    return {
      status: "ok",
      session_id: sessionId,
      output: waitResult.output,
      wait_matched: true,
      matched_pattern: waitResult.matchedPattern,
      elapsed_seconds: elapsed,
      output_total_chars: waitResult.totalChars,
      output_truncated: manager.get(sessionId)?.bufferOverflowed ?? false,
    };
  }

  if (waitResult.status === "timeout" && promoteOnTimeout) {
    const promoted = promoteSession(manager, sessionId);
    promoted.timed_out = true;
    promoted.elapsed_seconds = elapsed;
    return buildPromotedToolResult(
      promoted,
      waitResult.output,
      waitResult.totalChars,
      manager.get(sessionId)?.bufferOverflowed ?? false,
    );
  }

  if (waitResult.status === "timeout") {
    await manager.kill(sessionId);
    return {
      status: "timeout",
      session_id: sessionId,
      output: waitResult.output,
      elapsed_seconds: elapsed,
      output_total_chars: waitResult.totalChars,
      output_truncated: manager.get(sessionId)?.bufferOverflowed ?? false,
      hint: waitResult.hint,
    };
  }

  if (waitResult.status === "exited") {
    const session = manager.get(sessionId);
    return {
      status: "exited",
      session_id: sessionId,
      output: waitResult.output,
      exit_code: session?.exitCode ?? null,
      elapsed_seconds: elapsed,
      output_total_chars: waitResult.totalChars,
      output_truncated: session?.bufferOverflowed ?? false,
    };
  }

  return {
    status: "error",
    session_id: sessionId,
    output: waitResult.output,
    hint: waitResult.hint,
  };
}

export { exportOutput };
