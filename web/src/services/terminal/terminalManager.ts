/**
 * In-process terminal session manager.
 *
 * Owns the output ring buffer, completion events, and backend abstraction so the
 * wait service and tool adapters can operate without talking to the Tauri bridge
 * directly.
 */
import type { TerminalBackend, TerminalSession, TerminalSessionStatus, TerminalStartOptions } from "./types";
import {
  FOREGROUND_MAX_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
} from "./types";

interface SessionInternal extends TerminalSession {
  /** Lines kept for `poll(offset)`. */
  lineBuffer: string[];
  /** Full disk spill path when export is configured. */
  spillPath?: string;
}

class TerminalManager {
  private sessions = new Map<string, SessionInternal>();
  private unlisten?: () => void;

  constructor(private backend: TerminalBackend) {}

  /** Start listening to backend output events. */
  attach(): void {
    if (this.unlisten) return;
    this.unlisten = this.backend.onOutput((event) => {
      const session = this.sessions.get(event.terminalId);
      if (!session) return;

      if (event.data !== undefined) {
        this.appendOutput(session, event.data);
      }

      if (event.exitCode !== undefined) {
        session.status = "exited";
        session.exitCode = event.exitCode ?? null;
        this.resolveCompletion(session);
      }

      if (event.message !== undefined && event.message.includes("lost")) {
        session.status = "lost";
        this.resolveCompletion(session);
      }
    });
  }

  detach(): void {
    this.unlisten?.();
    this.unlisten = undefined;
  }

  async start(options: TerminalStartOptions): Promise<string> {
    this.attach();
    const { id, shell } = await this.backend.start(options);
    const session = this.createSession(id, options.command ?? shell, shell);
    this.sessions.set(id, session);
    return id;
  }

  private createSession(id: string, command: string, shell: string): SessionInternal {
    let completionResolve: () => void = () => {};
    const completionPromise = new Promise<void>((resolve) => {
      completionResolve = resolve;
    });
    return {
      id,
      command,
      status: "running",
      exitCode: null,
      outputBuffer: "",
      bufferOverflowed: false,
      scanCursor: 0,
      completionPromise,
      completionResolve,
      startedAt: Date.now(),
      shell,
      detached: false,
      completionConsumed: false,
      lineBuffer: [],
    };
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  list(): TerminalSession[] {
    return Array.from(this.sessions.values());
  }

  async write(id: string, data: string): Promise<void> {
    await this.backend.write(id, data);
  }

  async submitStdin(id: string, data: string): Promise<void> {
    // Windows ConPTY cooked input expects \r\n; POSIX expects \n.
    const lineEnding = typeof navigator !== "undefined" && navigator.platform.startsWith("Win") ? "\r\n" : "\n";
    await this.backend.write(id, `${data}${lineEnding}`);
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.backend.resize(id, cols, rows);
  }

  async kill(id: string): Promise<void> {
    await this.backend.kill(id);
    const session = this.sessions.get(id);
    if (session) {
      session.status = "exited";
      session.exitCode = session.exitCode ?? -1;
      this.resolveCompletion(session);
    }
  }

  async closeTab(id: string): Promise<void> {
    // Close the mirror tab without killing the process.
    const session = this.sessions.get(id);
    if (session) {
      session.detached = true;
    }
    if (this.backend.detach) {
      await this.backend.detach(id);
    }
  }

  appendOutput(session: SessionInternal, chunk: string): void {
    // Update rolling window.
    if (session.outputBuffer.length + chunk.length > MAX_OUTPUT_CHARS) {
      const keep = Math.max(0, MAX_OUTPUT_CHARS - chunk.length);
      session.outputBuffer = session.outputBuffer.slice(-keep) + chunk;
      session.bufferOverflowed = true;
    } else {
      session.outputBuffer += chunk;
    }

    // Update line buffer for poll() by splitting on line endings.
    const lines = chunk.split(/\r?\n/);
    if (lines.length === 1) {
      const last = session.lineBuffer[session.lineBuffer.length - 1];
      if (last !== undefined) {
        session.lineBuffer[session.lineBuffer.length - 1] = last + lines[0];
      } else {
        session.lineBuffer.push(lines[0]);
      }
    } else {
      const last = session.lineBuffer[session.lineBuffer.length - 1];
      if (last !== undefined) {
        session.lineBuffer[session.lineBuffer.length - 1] = last + lines[0];
      } else if (lines[0].length > 0) {
        session.lineBuffer.push(lines[0]);
      }
      for (let i = 1; i < lines.length - 1; i++) {
        session.lineBuffer.push(lines[i]);
      }
      session.lineBuffer.push(lines[lines.length - 1]);
    }

    // Clamp scan cursor so wait loops don't re-scan truncated text.
    if (session.scanCursor > session.outputBuffer.length) {
      session.scanCursor = session.outputBuffer.length;
    }
  }

  resolveCompletion(session: SessionInternal): void {
    if (session.completionConsumed) return;
    session.completionConsumed = true;
    session.completionResolve();
  }

  poll(id: string, offset = 0): { lines: string[]; totalLines: number; exitCode: number | null } {
    const session = this.sessions.get(id);
    if (!session) return { lines: [], totalLines: 0, exitCode: null };
    return {
      lines: session.lineBuffer.slice(offset),
      totalLines: session.lineBuffer.length,
      exitCode: session.exitCode,
    };
  }

  async readLog(id: string): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) return "";
    if (this.backend.readOutput) {
      return this.backend.readOutput(id);
    }
    return session.outputBuffer;
  }

  promoteSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = "promoted";
    session.detached = true;
    this.resolveCompletion(session);
  }
}

let sharedManager: TerminalManager | null = null;
let fakeBackend: TerminalBackend | null = null;

export function getTerminalManager(): TerminalManager | null {
  return sharedManager;
}

export function setTerminalManager(manager: TerminalManager | null): void {
  sharedManager = manager;
}

export function setFakeTerminalBackend(backend: TerminalBackend | null): void {
  fakeBackend = backend;
}

export function createTerminalManager(): TerminalManager {
  const backend = fakeBackend ?? createTauriTerminalBackend();
  const manager = new TerminalManager(backend);
  setTerminalManager(manager);
  return manager;
}

function createTauriTerminalBackend(): TerminalBackend {
  if (typeof window === "undefined" || !window.hermesDesktop?.terminalStart) {
    throw new Error("Tauri terminal bridge is not available");
  }
  const bridge = window.hermesDesktop;
  return {
    async start(options) {
      const initialInput =
        options.command && options.mode !== "interactive" ? `${options.command}\n` : options.command;
      const result = await bridge.terminalStart!({
        purpose: "shell",
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        initialInput,
      });
      return { id: result.terminalId, shell: result.shell };
    },
    async write(id, data) {
      await bridge.terminalWrite!({ terminalId: id, data });
    },
    async resize(id, cols, rows) {
      await bridge.terminalResize!({ terminalId: id, cols, rows });
    },
    async kill(id) {
      await bridge.terminalClose!({ terminalId: id });
    },
    async detach(id) {
      if (bridge.terminalDetach) {
        await bridge.terminalDetach({ terminalId: id });
      }
    },
    onOutput(handler) {
      return bridge.onTerminalOutput!((event) => {
        handler({
          terminalId: event.terminalId,
          data: event.data ?? undefined,
          exitCode: event.exitCode ?? undefined,
          message: event.message ?? undefined,
        });
      });
    },
  };
}

export { TerminalManager, FOREGROUND_MAX_TIMEOUT_MS, MAX_OUTPUT_CHARS };
