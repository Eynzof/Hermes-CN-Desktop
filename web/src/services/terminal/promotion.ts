/**
 * Foreground-to-background promotion helper.
 *
 * When a tool specifies `promote_on_timeout` or `wait_for_pattern`, the running
 * PTY is adopted into the session registry instead of being killed on timeout.
 */
import type { TerminalManager } from "./terminalManager";
import type { TerminalToolResult } from "./types";

export interface PromotionResult {
  status: "promoted";
  session_id: string;
  timed_out: boolean;
  pattern_matched: boolean;
  matched_pattern?: string;
  elapsed_seconds: number;
}

export function buildPromotedToolResult(
  result: PromotionResult,
  output: string,
  totalChars: number,
  truncated: boolean,
): TerminalToolResult {
  return {
    status: "promoted",
    session_id: result.session_id,
    output,
    wait_matched: result.pattern_matched,
    matched_pattern: result.matched_pattern,
    elapsed_seconds: result.elapsed_seconds,
    output_total_chars: totalChars,
    output_truncated: truncated,
  };
}

export function promoteSession(manager: TerminalManager, sessionId: string): PromotionResult {
  manager.promoteSession(sessionId);
  return {
    status: "promoted",
    session_id: sessionId,
    timed_out: false,
    pattern_matched: false,
    elapsed_seconds: 0,
  };
}
