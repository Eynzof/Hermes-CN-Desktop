import type { TerminalResult } from "./types.js";

export interface CancellableProcess {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  kill(): void;
}

export class ThreadedProcessHandle {
  private stdout = "";
  private stderr = "";
  private exitCode: number | null = null;
  private cancelled = false;

  constructor(private run: () => Promise<{ stdout: string; stderr: string; exitCode: number }>) {}

  async wait(timeoutMs?: number): Promise<TerminalResult> {
    const start = Date.now();
    const result = await this.run();
    if (this.cancelled) {
      return { output: "", exitCode: 1, degraded: { reason: "cancelled", retryHint: "retry" } };
    }
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
    const output = this.stdout + (this.stderr ? `\n${this.stderr}` : "");
    return {
      output: this.boundOutput(output),
      exitCode: this.exitCode ?? -1,
      truncated: output.length > 10000,
    };
  }

  cancel(): void {
    this.cancelled = true;
  }

  private boundOutput(text: string): string {
    const max = 10000;
    if (text.length <= max) return text;
    const head = text.slice(0, 4000);
    const tail = text.slice(-6000);
    return `${head}\n...truncated...\n${tail}`;
  }
}
