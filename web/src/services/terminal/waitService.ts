/**
 * Blocking pattern wait service for in-process terminal sessions.
 *
 * Mirrors Python `process_registry.wait()`:
 * - scans *new* text between `scanCursor` and the current buffer length
 * - supports regex pattern, inactivity timeout, hard timeout
 * - returns status='matched' while the process keeps running
 * - AbortController-based user interrupt
 */
import type { TerminalSession, TerminalWaitResult, TerminalWaitStatus } from "./types";
import {
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  FOREGROUND_MAX_TIMEOUT_MS,
  ROLLING_REGEX_TAIL_CHARS,
} from "./types";

export interface WaitOptions {
  /** Maximum total wait time in seconds. */
  timeout?: number;
  /** Regex pattern to scan for. */
  pattern?: string;
  /** Return early after N seconds of no new output while pattern is set. */
  inactivityTimeout?: number;
  /** Only scan text after this character offset. */
  sinceChars?: number;
}

export class TerminalWaitService {
  /** Wait for a pattern, inactivity, or timeout. */
  async wait(
    session: TerminalSession,
    options: WaitOptions,
    signal?: AbortSignal,
  ): Promise<TerminalWaitResult> {
    const start = Date.now();
    const hardTimeoutMs = this.clampTimeout(options.timeout ?? 600) * 1000;
    const inactivityMs = this.resolveInactivity(options);

    let regex: RegExp | null = null;
    if (options.pattern) {
      try {
        regex = new RegExp(options.pattern, "g");
      } catch {
        return {
          status: "error",
          output: "",
          totalChars: session.outputBuffer.length,
          hint: "Invalid regex pattern",
        };
      }
    }

    let lastLen = Math.max(options.sinceChars ?? session.scanCursor, 0);
    let lastActivity = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) {
        return this.result(session, "interrupted", lastLen, options.sinceChars);
      }

      const now = Date.now();
      const elapsed = now - start;
      if (elapsed >= hardTimeoutMs) {
        return this.result(session, "timeout", lastLen, options.sinceChars);
      }

      // Exited while waiting.
      if (session.status === "exited" || session.status === "lost") {
        return this.result(session, "exited", lastLen, options.sinceChars);
      }

      const currentLen = session.outputBuffer.length;
      if (currentLen > lastLen) {
        lastActivity = now;
        const newText = session.outputBuffer.slice(lastLen);
        session.scanCursor = currentLen;

        if (regex) {
          // Use a rolling tail so cross-chunk matches that straddle the boundary work.
          const searchWindow = session.outputBuffer.slice(
            Math.max(0, currentLen - Math.max(ROLLING_REGEX_TAIL_CHARS, newText.length + 1024)),
          );
          regex.lastIndex = 0;
          const match = regex.exec(searchWindow);
          if (match) {
            return this.result(session, "matched", lastLen, options.sinceChars, match[0]);
          }
        } else {
          // No pattern: return on first new output.
          return this.result(session, "output", lastLen, options.sinceChars);
        }

        lastLen = currentLen;
      }

      if (regex && inactivityMs > 0 && now - lastActivity >= inactivityMs) {
        return this.result(session, "timeout", lastLen, options.sinceChars);
      }

      // 100 ms polling matches Python's 1 s but keeps UI responsive; fine for tests.
      await this.sleep(Math.min(100, Math.max(0, hardTimeoutMs - elapsed)));
    }
  }

  private clampTimeout(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds <= 0) return 600;
    return Math.min(seconds, FOREGROUND_MAX_TIMEOUT_MS / 1000);
  }

  private resolveInactivity(options: WaitOptions): number {
    if (options.inactivityTimeout !== undefined) {
      return options.inactivityTimeout * 1000;
    }
    if (options.pattern) {
      return DEFAULT_INACTIVITY_TIMEOUT_MS;
    }
    return 0;
  }

  private result(
    session: TerminalSession,
    status: TerminalWaitStatus,
    since: number,
    sinceChars?: number,
    matchedPattern?: string,
  ): TerminalWaitResult {
    const baseline = sinceChars ?? since;
    const output = session.outputBuffer.slice(Math.max(0, baseline));
    return {
      status,
      output,
      totalChars: session.outputBuffer.length,
      matchedPattern,
      hint: status === "timeout" ? "Timed out waiting for pattern" : undefined,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const terminalWaitService = new TerminalWaitService();
