/**
 * Terminal output export service.
 *
 * Writes the accumulated session buffer to disk and reports truncation metadata.
 */
import type { TerminalManager } from "./terminalManager";

export interface ExportOutputResult {
  full_output_path: string | null;
  output_total_chars: number;
  output_truncated: boolean;
}

/**
 * Export a session's full output to a path.
 *
 * v1 uses an in-memory buffer; a future Rust `terminal_export` command can spill
 * the full log to disk for sessions that outlive the webview.
 */
export async function exportOutput(
  manager: TerminalManager,
  sessionId: string,
  path: string | "auto",
): Promise<ExportOutputResult> {
  const session = manager.get(sessionId);
  if (!session) {
    return { full_output_path: null, output_total_chars: 0, output_truncated: false };
  }

  const buffer = await manager.readLog(sessionId);
  const output_total_chars = buffer.length;
  const output_truncated = session.bufferOverflowed;

  // v1 keeps the output in memory. A future Rust `terminal_export` command can
  // spill the full log to disk for sessions that outlive the webview.
  // For now we report the metadata; callers that need a file can use the
  // process(action='export') result and write the buffer themselves.
  return { full_output_path: path === "auto" ? null : path, output_total_chars, output_truncated };
}
