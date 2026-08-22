/**
 * Terminal ergonomics types.
 *
 * Mirrors the Python ProcessSession / terminal_tool contract so the in-process
 * terminal tool adapter can replace the WS-bridged Python gateway path.
 */

export type TerminalSessionStatus =
  | "running"
  | "exited"
  | "promoted"
  | "lost"
  | "error";

export interface TerminalSession {
  /** Stable session identifier. */
  id: string;
  /** Display command or shell preview. */
  command: string;
  /** Current lifecycle status. */
  status: TerminalSessionStatus;
  /** Exit code when status is 'exited'. */
  exitCode: number | null;
  /** Rolling output window (newest chars authoritative). */
  outputBuffer: string;
  /** True if the rolling window overflowed its cap. */
  bufferOverflowed: boolean;
  /** Number of chars already consumed by wait scans. */
  scanCursor: number;
  /** Resolves when the process exits or is promoted. */
  completionPromise: Promise<void>;
  /** Manual resolver for completionPromise. */
  completionResolve: () => void;
  /** Start timestamp. */
  startedAt: number;
  /** Shell program actually used (e.g. cmd.exe, bash). */
  shell: string;
  /** PTY handle ref supplied by the backend. */
  ptyHandleRef?: unknown;
  /** True after a promotion / detach so the UI can stop mirroring. */
  detached: boolean;
  /** True once completionPromise has been resolved. */
  completionConsumed: boolean;
}

export type TerminalWaitStatus =
  | "exited"
  | "matched"
  | "output"
  | "timeout"
  | "interrupted"
  | "not_found"
  | "error";

export interface TerminalWaitResult {
  status: TerminalWaitStatus;
  /** New text since the wait started (or since sinceChars). */
  output: string;
  /** Total chars in the buffer at return time. */
  totalChars: number;
  /** Pattern that matched, if any. */
  matchedPattern?: string;
  /** Human-readable hint / error. */
  hint?: string;
}

export interface TerminalStartOptions {
  command?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  mode?: TerminalMode;
  interactive?: boolean;
  /** Background sessions keep running after the tool returns. */
  background?: boolean;
  /** Timeout in seconds (foreground cap). */
  timeout?: number;
  /** Regex pattern to wait for on new output. */
  waitForPattern?: string;
  /** Return early if silent for N seconds while waiting for a pattern. */
  inactivityTimeout?: number;
  /** Promote to background instead of killing on timeout. */
  promoteOnTimeout?: boolean;
  /** Notify on completion (background only). */
  notifyOnComplete?: boolean;
  /** Max output lines to capture for the tool result. */
  maxLines?: number;
}

export type TerminalMode =
  | "run"
  | "execute"
  | "foreground"
  | "fg"
  | "background"
  | "bg"
  | "async"
  | "detach"
  | "interactive"
  | "repl"
  | "shell";

export interface TerminalToolResult {
  status: "ok" | "exited" | "promoted" | "timeout" | "error";
  session_id?: string;
  exit_code?: number | null;
  output?: string;
  /** True if wait_for_pattern matched while the process kept running. */
  wait_matched?: boolean;
  matched_pattern?: string;
  elapsed_seconds?: number;
  output_total_chars?: number;
  output_truncated?: boolean;
  full_output_path?: string | null;
  hint?: string;
}

export interface ProcessActionInput {
  action: ProcessAction;
  session_id: string;
  data?: string;
  timeout?: number;
  pattern?: string;
  inactivity_timeout?: number;
  block?: boolean;
  output_path?: string | "auto";
  offset?: number;
  limit?: number;
}

export type ProcessAction =
  | "list"
  | "poll"
  | "log"
  | "wait"
  | "kill"
  | "write"
  | "submit"
  | "close"
  | "export";

export interface ProcessToolResult {
  status: string;
  output?: string;
  total_lines?: number;
  exit_code?: number | null;
  exit_code_meaning?: string;
  full_output_path?: string | null;
  output_total_chars?: number;
  output_truncated?: boolean;
  hint?: string;
}

export interface TerminalBackend {
  start(options: TerminalStartOptions): Promise<{ id: string; shell: string }>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  /** Detach stops mirroring without killing the underlying process. */
  detach?(id: string): Promise<void>;
  /** Read accumulated output from disk for export. */
  readOutput?(id: string): Promise<string>;
  onOutput(handler: (event: { terminalId: string; data?: string; exitCode?: number; message?: string }) => void): () => void;
}

export const MAX_OUTPUT_CHARS = 200 * 1024;
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 120_000;
export const FOREGROUND_MAX_TIMEOUT_MS = 600_000;
export const ROLLING_REGEX_TAIL_CHARS = 4096;
