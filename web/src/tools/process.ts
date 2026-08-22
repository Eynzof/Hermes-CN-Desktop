/**
 * In-process `process` tool adapter.
 *
 * Exposes the same surface as Python's `PROCESS_SCHEMA` actions: list, poll, log,
 * wait, kill, write, submit, close, export. All operate on the local
 * TerminalManager registry.
 */
import { getTerminalManager, createTerminalManager } from "@/services/terminal/terminalManager";
import { terminalWaitService } from "@/services/terminal/waitService";
import { exportOutput } from "@/services/terminal/export";
import type { ProcessActionInput, ProcessToolResult, TerminalSessionStatus } from "@/services/terminal/types";

function statusMeaning(status: TerminalSessionStatus, exitCode: number | null): string {
  if (status === "running") return "running";
  if (status === "promoted") return "promoted";
  if (exitCode === 0) return "exited_clean";
  if (exitCode === 124 || exitCode === -1) return "killed";
  return "exited_error";
}

export async function processTool(input: ProcessActionInput): Promise<ProcessToolResult> {
  let manager = getTerminalManager();
  if (!manager) {
    manager = createTerminalManager();
  }

  switch (input.action) {
    case "list": {
      const sessions = manager.list();
      const output = sessions
        .map((s) => `${s.id}\t${s.status}\t${s.command}`)
        .join("\n");
      return { status: "ok", output, total_lines: sessions.length };
    }

    case "poll": {
      const result = manager.poll(input.session_id, input.offset ?? 0);
      const output = result.lines.join("\n");
      return {
        status: "ok",
        output,
        total_lines: result.totalLines,
        exit_code: result.exitCode,
        exit_code_meaning: statusMeaning(manager.get(input.session_id)?.status ?? "running", result.exitCode),
      };
    }

    case "log": {
      const buffer = await manager.readLog(input.session_id);
      return {
        status: "ok",
        output: buffer,
        total_lines: buffer.split("\n").length,
      };
    }

    case "wait": {
      const session = manager.get(input.session_id);
      if (!session) {
        return { status: "not_found", output: "", hint: `No session ${input.session_id}` };
      }
      if (session.status === "exited" || session.status === "lost") {
        return {
          status: "exited",
          output: "",
          exit_code: session.exitCode,
          exit_code_meaning: statusMeaning(session.status, session.exitCode),
        };
      }
      const wait = await terminalWaitService.wait(session, {
        timeout: input.timeout,
        pattern: input.pattern,
        inactivityTimeout: input.inactivity_timeout,
      });
      return {
        status: wait.status,
        output: wait.output,
        total_lines: wait.output.split("\n").length,
      };
    }

    case "kill": {
      await manager.kill(input.session_id);
      return { status: "ok", output: "" };
    }

    case "write":
    case "submit": {
      if (input.data === undefined) {
        return { status: "error", output: "", hint: "data is required for write/submit" };
      }
      await manager.submitStdin(input.session_id, input.data);
      return { status: "ok", output: "" };
    }

    case "close": {
      await manager.closeTab(input.session_id);
      return { status: "ok", output: "" };
    }

    case "export": {
      const result = await exportOutput(manager, input.session_id, input.output_path ?? "auto");
      return {
        status: "ok",
        output: "",
        full_output_path: result.full_output_path,
        output_total_chars: result.output_total_chars,
        output_truncated: result.output_truncated,
      };
    }

    default:
      return { status: "error", output: "", hint: `Unsupported action: ${input.action}` };
  }
}
