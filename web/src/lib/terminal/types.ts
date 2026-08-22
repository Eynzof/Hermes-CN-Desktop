/**
 * Terminal backend types.
 */

export type TerminalEnvType = "local" | "docker" | "ssh" | "singularity" | "modal" | "daytona" | "vercel_sandbox";

export interface TerminalFrame {
  data: string;
  seq: number;
}

export interface TerminalProcess {
  readonly onData: (cb: (data: string) => void) => () => void;
  readonly onExit: (cb: (ev: { exitCode: number | null }) => void) => () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface TerminalResult {
  output: string;
  exitCode: number;
  truncated?: boolean;
  spillPath?: string;
  degraded?: { reason: string; retryHint: string };
}

export interface TerminalExecuteOptions {
  cwd?: string;
  timeout?: number;
  background?: boolean;
  env?: Record<string, string | undefined>;
}

export interface EnvConfig {
  image?: string;
  containerCpu?: number;
  containerMemory?: string;
  dockerVolumes?: string[];
  sshHost?: string;
  sshUser?: string;
  modalMode?: "direct" | "managed" | "auto";
  daytonaImage?: string;
  vercelRuntime?: string;
}

export interface TerminalBackend {
  readonly kind: TerminalEnvType;
  createSession(opts: { cwd: string; shell?: string; cols?: number; rows?: number }): Promise<TerminalProcess>;
  execute(opts: TerminalExecuteOptions & { command: string }): Promise<TerminalResult>;
  cleanup(): Promise<void>;
}
