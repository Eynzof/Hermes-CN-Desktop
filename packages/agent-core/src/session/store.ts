import type { ProfileSnapshot } from "../types.js";

export interface AgentSession {
  id: string;
  parentSessionId?: string;
  source?: string;
  userId?: string;
  title: string;
  preview?: string;
  cwd?: string;
  startedAt: number;
  endedAt?: number;
  endReason?: string;
  messageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  isActive: boolean;
  profile: ProfileSnapshot;
  /** Opaque session metadata bag used by checkpoint/snapshot managers. */
  metadata?: Record<string, unknown>;
}

export interface AgentSessionMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  images?: unknown[];
  toolCallId?: string;
  toolCalls?: unknown[];
  toolName?: string;
  timestamp: number;
  tokenCount?: number;
  finishReason?: string;
  reasoning?: string;
  reasoningContent?: string;
}

export interface CreateSessionOptions {
  title?: string;
  cwd?: string;
  userId?: string;
  source?: string;
  parentSessionId?: string;
}

export interface SessionStore {
  createSession(profile: ProfileSnapshot, options?: CreateSessionOptions): Promise<AgentSession>;
  getSession(id: string): Promise<AgentSession | undefined>;
  listSessions(): Promise<AgentSession[]>;
  saveSession(session: AgentSession): Promise<void>;
  archiveSession(id: string): Promise<boolean>;
  appendMessage(message: AgentSessionMessage): Promise<void>;
  getMessages(sessionId: string): Promise<AgentSessionMessage[]>;
  /**
   * Read a metadata key for a session. Implementations are optional; the default
   * behaviour is to return undefined.
   */
  getSessionMetadata?(sessionId: string, key: string): Promise<unknown | undefined>;
  /**
   * Write a metadata key for a session. Implementations are optional; the default
   * behaviour is a no-op.
   */
  setSessionMetadata?(sessionId: string, key: string, value: unknown): Promise<void>;
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly messages = new Map<string, AgentSessionMessage[]>();

  async createSession(
    profile: ProfileSnapshot,
    options: CreateSessionOptions = {},
  ): Promise<AgentSession> {
    const now = Date.now();
    const session: AgentSession = {
      id: randomId(),
      parentSessionId: options.parentSessionId,
      source: options.source,
      userId: options.userId,
      title: options.title ?? "New session",
      preview: "",
      cwd: options.cwd,
      startedAt: now,
      isActive: true,
      messageCount: 0,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      profile,
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  async getSession(id: string): Promise<AgentSession | undefined> {
    return this.sessions.get(id);
  }

  async listSessions(): Promise<AgentSession[]> {
    return Array.from(this.sessions.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  async saveSession(session: AgentSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async archiveSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.isActive = false;
    session.endedAt = Date.now();
    this.sessions.set(id, session);
    return true;
  }

  async appendMessage(message: AgentSessionMessage): Promise<void> {
    const list = this.messages.get(message.sessionId);
    if (!list) {
      this.messages.set(message.sessionId, [message]);
      return;
    }
    list.push(message);
  }

  async getMessages(sessionId: string): Promise<AgentSessionMessage[]> {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async getSessionMetadata(sessionId: string, key: string): Promise<unknown | undefined> {
    const session = this.sessions.get(sessionId);
    return session?.metadata?.[key];
  }

  async setSessionMetadata(sessionId: string, key: string, value: unknown): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.metadata = { ...session.metadata, [key]: value };
    this.sessions.set(sessionId, { ...session });
  }
}
