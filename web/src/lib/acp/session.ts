import { AcpSessionStateSchema, type AcpSessionState } from "@hermes/protocol/acp";

export class AcpSessionManager {
  private sessions = new Map<string, AcpSessionState>();

  create(sessionId: string, initial?: Partial<AcpSessionState>): AcpSessionState {
    const state: AcpSessionState = AcpSessionStateSchema.parse({
      sessionId,
      ...initial,
    });
    this.sessions.set(sessionId, state);
    return state;
  }

  get(sessionId: string): AcpSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  list(): AcpSessionState[] {
    return Array.from(this.sessions.values());
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }
}
