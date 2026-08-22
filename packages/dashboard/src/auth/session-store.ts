import { hmac, randomHex } from "./crypto";
import type { CreateSessionInput, DashboardSessionStore, Session, TokenPrincipal } from "./provider";

interface StoredSession extends Session {
  principal: TokenPrincipal;
}

/**
 * In-memory session store with HMAC-signed access tokens.
 *
 * A stable secret makes token verification deterministic across restarts.
 * For real deployments this secret should be persisted in the Rust AppState;
 * the default empty secret is suitable only for tests.
 */
export interface InMemorySessionStoreOptions {
  /** HMAC secret. A random secret is generated when omitted. */
  secret?: string;
}

export function createInMemorySessionStore(
  options: InMemorySessionStoreOptions = {},
): DashboardSessionStore {
  const secret = options.secret ?? randomHex(32);
  const sessions = new Map<string, StoredSession>();
  const revoked = new Set<string>();

  async function sign(sessionId: string): Promise<string> {
    return hmac(sessionId, secret);
  }

  return {
    async getSession(sessionId: string): Promise<Session | null> {
      const session = sessions.get(sessionId);
      if (!session || revoked.has(sessionId)) return null;
      return session;
    },

    async createSession(input: CreateSessionInput): Promise<Session> {
      const id = input.id ?? input.sub ?? randomHex(16);
      const session: StoredSession = {
        id,
        displayName: input.displayName,
        email: input.email,
        accessToken: `${id}.${await sign(id)}`,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt,
        principal: { sub: input.sub ?? id, scopes: input.scopes ?? ["dashboard"] },
      };
      sessions.set(id, session);
      return session;
    },

    async verifyAccessToken(token: string): Promise<TokenPrincipal | null> {
      const dot = token.indexOf(".");
      if (dot <= 0) return null;
      const sessionId = token.slice(0, dot);
      const signature = token.slice(dot + 1);
      if (revoked.has(sessionId)) return null;
      const expected = await sign(sessionId);
      if (signature !== expected) return null;
      const session = sessions.get(sessionId);
      if (!session) return null;
      if (session.expiresAt && session.expiresAt.getTime() < Date.now()) return null;
      return session.principal;
    },

    async revokeSession(sessionId: string): Promise<void> {
      revoked.add(sessionId);
    },
  };
}
