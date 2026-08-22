import type { CodexTurnResult } from "./types.js";

export interface CodexSession {
  sessionId: string;
  threadId?: string;
}

export class CodexSessionManager {
  private sessions = new Map<string, CodexSession>();

  create(sessionId: string): CodexSession {
    const session: CodexSession = { sessionId };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): CodexSession | undefined {
    return this.sessions.get(sessionId);
  }

  recordTurn(sessionId: string, result: CodexTurnResult): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.threadId = result.threadId ?? session.threadId;
    }
  }
}
