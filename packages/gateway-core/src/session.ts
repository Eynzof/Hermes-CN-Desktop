/**
 * Session source / key builder / multiplexer parity with Python gateway/session.py.
 *
 * v1 keeps an in-memory LRU + TTL session store. The session key layout is
 * byte-identical to Python's `agent:main:<platform>:<chatType>:<chatId>[:<userId>]`.
 */

import { z } from "zod";
import type { InboundMessageEvent } from "./adapter.js";

export const sessionSourceSchema = z.object({
  platform: z.string(),
  chatId: z.string(),
  chatType: z.enum(["dm", "group", "channel", "thread"]),
  userId: z.string(),
  threadId: z.string().optional(),
  scopeId: z.string().optional(),
  profile: z.string().optional(),
});
export type SessionSource = z.infer<typeof sessionSourceSchema>;

export const gatewaySessionSchema = z.object({
  sessionId: z.string(),
  sessionKey: z.string(),
  platform: z.string(),
  chatId: z.string(),
  chatType: z.enum(["dm", "group", "channel", "thread"]),
  userId: z.string(),
  threadId: z.string().optional(),
  scopeId: z.string().optional(),
  profile: z.string().optional(),
  title: z.string().optional(),
  modelOverride: z.string().optional(),
  createdAt: z.number(),
  lastActiveAt: z.number(),
  restartInterrupted: z.boolean().optional(),
});
export type GatewaySession = z.infer<typeof gatewaySessionSchema>;

export type RouteDecision =
  | { action: "run"; sessionId: string }
  | { action: "queue"; sessionId: string }
  | { action: "steer"; sessionId: string }
  | { action: "interrupt"; sessionId: string }
  | { action: "drop_auth"; reason: string }
  | { action: "slash"; command: string; args: string; sessionId: string };

const MAX_SIZE = 128;
const IDLE_TTL_MS = 3600_000;

export function buildSessionKey(source: SessionSource, profile = "main"): string {
  const base = `agent:${profile}:${source.platform}:${source.chatType}:${source.chatId}`;
  if (source.userId) return `${base}:${source.userId}`;
  return base;
}

export function sessionIdFromKey(key: string): string {
  // Stable id derived from the session key for parity.
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(31, h) + key.charCodeAt(i);
  }
  return `sess_${(h >>> 0).toString(16).padStart(12, "0")}`;
}

export class SessionStore {
  private sessions = new Map<string, GatewaySession>();

  get(sessionId: string): GatewaySession | undefined {
    return this.sessions.get(sessionId);
  }

  getByKey(sessionKey: string): GatewaySession | undefined {
    return [...this.sessions.values()].find((s) => s.sessionKey === sessionKey);
  }

  ensure(source: SessionSource): GatewaySession {
    const key = buildSessionKey(source, source.profile);
    const existing = this.getByKey(key);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }
    this.evictIfNeeded();
    const session: GatewaySession = {
      sessionId: sessionIdFromKey(key),
      sessionKey: key,
      ...source,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastActiveAt = Date.now();
  }

  evictIdleSessions(now = Date.now()): number {
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.lastActiveAt > IDLE_TTL_MS) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  private evictIfNeeded(): void {
    if (this.sessions.size < MAX_SIZE) return;
    // Evict least-recently active.
    const sorted = [...this.sessions.entries()].sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);
    const toRemove = Math.ceil(MAX_SIZE * 0.1);
    for (let i = 0; i < toRemove; i++) {
      this.sessions.delete(sorted[i][0]);
    }
  }
}

export interface SessionMultiplexerOptions {
  allowedCommands?: Set<string>;
  busyMode?: "queue" | "interrupt" | "steer";
  isAdmin?: (event: InboundMessageEvent) => boolean;
}

export class SessionMultiplexer {
  private busySessions = new Set<string>();

  constructor(
    private store: SessionStore,
    private opts: SessionMultiplexerOptions = {},
  ) {}

  route(event: InboundMessageEvent): RouteDecision {
    const source = sessionSourceSchema.parse({
      platform: event.platform,
      chatId: event.chatId,
      chatType: event.chatType,
      userId: event.userId,
      threadId: event.threadId,
      scopeId: event.scopeId,
    });
    const session = this.store.ensure(source);

    const text = event.parts.find((p) => p.type === "text")?.text ?? "";
    if (text.startsWith("/")) {
      const trimmed = text.slice(1).trim();
      const [cmd, ...rest] = trimmed.split(/\s+/);
      return { action: "slash", command: cmd ?? "", args: rest.join(" "), sessionId: session.sessionId };
    }

    if (this.opts.isAdmin && !this.opts.isAdmin(event)) {
      return { action: "drop_auth", reason: "unauthorized" };
    }

    if (this.busySessions.has(session.sessionId)) {
      const mode = this.opts.busyMode ?? "queue";
      if (mode === "interrupt") return { action: "interrupt", sessionId: session.sessionId };
      if (mode === "steer") return { action: "steer", sessionId: session.sessionId };
      return { action: "queue", sessionId: session.sessionId };
    }

    return { action: "run", sessionId: session.sessionId };
  }

  markBusy(sessionId: string, busy: boolean): void {
    if (busy) this.busySessions.add(sessionId);
    else this.busySessions.delete(sessionId);
  }

  resetIfDue(sessionId: string): void {
    const s = this.store.get(sessionId);
    if (!s) return;
    // v1: no-op unless daily-reset policy is configured.
  }
}
