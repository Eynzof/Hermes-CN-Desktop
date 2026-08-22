import type { EnvConfig, TerminalBackend, TerminalEnvType, TerminalResult } from "./types.js";

class LocalBackend implements TerminalBackend {
  readonly kind: TerminalEnvType = "local";
  async createSession(_opts: { cwd: string; shell?: string; cols?: number; rows?: number }): Promise<import("./types.js").TerminalProcess> {
    throw new Error("local terminal uses Rust portable-pty via tauri-bridge");
  }
  async execute(_opts: Parameters<TerminalBackend["execute"]>[0]): Promise<TerminalResult> {
    return { output: "", exitCode: 0, degraded: { reason: "local backend uses Rust IPC", retryHint: "use tauri-bridge" } };
  }
  async cleanup(): Promise<void> {}
}

class StubBackend implements TerminalBackend {
  constructor(readonly kind: TerminalEnvType) {}
  async createSession(_opts: { cwd: string; shell?: string; cols?: number; rows?: number }): Promise<import("./types.js").TerminalProcess> {
    throw new Error(`${this.kind} interactive session not implemented in browser`);
  }
  async execute(_opts: Parameters<TerminalBackend["execute"]>[0]): Promise<TerminalResult> {
    return {
      output: `[${this.kind}] command would execute via Rust sidecar / REST`,
      exitCode: 0,
      degraded: { reason: `${this.kind} backend is stubbed`, retryHint: "run via Rust command" },
    };
  }
  async cleanup(): Promise<void> {}
}

export function createBackend(kind: TerminalEnvType, _config: EnvConfig, _taskId?: string): TerminalBackend {
  switch (kind) {
    case "local":
      return new LocalBackend();
    case "docker":
    case "ssh":
    case "singularity":
    case "modal":
    case "daytona":
    case "vercel_sandbox":
      return new StubBackend(kind);
    default:
      throw new Error(`Unknown terminal backend: ${kind}`);
  }
}

export function isTerminalEnvType(value: string): value is TerminalEnvType {
  return ["local", "docker", "ssh", "singularity", "modal", "daytona", "vercel_sandbox"].includes(value);
}
