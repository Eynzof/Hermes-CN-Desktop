/**
 * Surface-agnostic controls for the in-process agent loop.
 *
 * This module provides typed stubs that map slash-command run-control requests
 * (`/stop`, `/queue`, `/steer`, `/background`) to the agent-core runtime
 * surface (`cancel`, `steer`, `startBtw`). Hosts (Tauri webview, browser
 * companion, tests) inject the concrete runtime implementation.
 */

export interface AgentRuntimeHandle {
  /** Cancel the currently running turn for the active session. */
  cancel(sessionId?: string): Promise<boolean>;
  /** Inject a steering prompt to be applied after the next tool call. */
  steer(sessionId: string, prompt: string): Promise<boolean>;
  /** Start a detached background session with the given prompt. */
  startBtw(sessionId: string, prompt: string): Promise<{ backgroundSessionId: string } | null>;
  /** List currently running background sessions. */
  listBackgroundSessions(): Promise<string[]>;
}

/** No-op runtime used when no agent loop is wired in yet. */
export const noopRuntime: AgentRuntimeHandle = {
  async cancel() {
    return false;
  },
  async steer() {
    return false;
  },
  async startBtw() {
    return null;
  },
  async listBackgroundSessions() {
    return [];
  },
};

let runtimeHandle: AgentRuntimeHandle = noopRuntime;

export function registerAgentRuntime(handle: AgentRuntimeHandle): void {
  runtimeHandle = handle;
}

export function getAgentRuntime(): AgentRuntimeHandle {
  return runtimeHandle;
}

/** `/stop` — cancel the running turn and any background tasks. */
export async function stopAgent(sessionId?: string): Promise<boolean> {
  return runtimeHandle.cancel(sessionId);
}

/** `/steer <prompt>` — queue a steering instruction for the running turn. */
export async function steerAgent(sessionId: string, prompt: string): Promise<boolean> {
  return runtimeHandle.steer(sessionId, prompt);
}

/** `/background <prompt>` — start a detached background session. */
export async function startBackgroundAgent(
  sessionId: string,
  prompt: string,
): Promise<{ backgroundSessionId: string } | null> {
  return runtimeHandle.startBtw(sessionId, prompt);
}

/** List active background sessions. */
export async function listBackgroundAgents(): Promise<string[]> {
  return runtimeHandle.listBackgroundSessions();
}
