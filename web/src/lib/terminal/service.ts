import { createBackend } from "./factory.js";
import type { EnvConfig, TerminalBackend, TerminalEnvType, TerminalProcess, TerminalResult } from "./types.js";

interface TerminalRecord {
  backend: TerminalBackend;
  process?: TerminalProcess;
  frames: string[];
  closed: boolean;
}

export class TerminalService {
  private records = new Map<string, TerminalRecord>();

  constructor(private config: EnvConfig) {}

  async execute(kind: TerminalEnvType, command: string, opts?: { cwd?: string; timeout?: number }): Promise<TerminalResult> {
    const backend = createBackend(kind, this.config);
    return backend.execute({ command, cwd: opts?.cwd ?? ".", timeout: opts?.timeout ?? 60000 });
  }

  async create(kind: TerminalEnvType, opts: { cwd: string; cols?: number; rows?: number }): Promise<string> {
    const backend = createBackend(kind, this.config);
    const sessionId = `${kind}-${Date.now()}`;
    const process = await backend.createSession(opts);
    this.records.set(sessionId, { backend, process, frames: [], closed: false });
    return sessionId;
  }

  getSession(id: string): TerminalRecord | undefined {
    return this.records.get(id);
  }

  async cleanup(kind: TerminalEnvType, taskId?: string): Promise<void> {
    for (const [id, rec] of this.records) {
      if (id.startsWith(kind)) {
        await rec.backend.cleanup();
        this.records.delete(id);
      }
    }
    if (taskId) {
      const rec = this.records.get(taskId);
      if (rec) await rec.backend.cleanup();
      this.records.delete(taskId);
    }
  }
}
