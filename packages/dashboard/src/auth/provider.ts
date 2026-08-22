/**
 * In-process dashboard auth provider interface.
 *
 * Mirrors the Python `DashboardAuthProvider` ABC from
 * `hermes_cli/dashboard_auth/base.py`. Implementations live in the desktop
 * process; there is no HTTP cookie jar. The session store is injected so tests
 * can run without touching disk or real crypto.
 */

export interface LoginStart {
  /** URL to open in the user's browser for the OAuth/OIDC dance. */
  authorizationUrl: string;
  /** CSRF state. */
  state: string;
  /** OIDC nonce, when required. */
  nonce?: string;
}

export interface Session {
  /** Stable session id (the access token's signed payload). */
  id: string;
  displayName?: string;
  email?: string;
  /** Short-lived bearer token presented to local handlers. */
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface TokenPrincipal {
  /** Subject identifier. */
  sub: string;
  scopes?: string[];
}

export interface CreateSessionInput
  extends Omit<Session, "accessToken" | "id"> {
  id?: string;
  /** Subject identifier for the token principal. Defaults to the session id. */
  sub?: string;
  scopes?: string[];
}

/** Pluggable session store used by all auth providers. */
export interface DashboardSessionStore {
  createSession(session: CreateSessionInput): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  verifyAccessToken(token: string): Promise<TokenPrincipal | null>;
  revokeSession(sessionId: string): Promise<void>;
}

/** Auth provider contract for the local-first dashboard. */
export interface DashboardAuthProvider {
  name: string;
  displayName: string;
  supportsPassword?: boolean;
  supportsToken?: boolean;

  /** OAuth/OIDC: build the authorization URL. */
  startLogin?(opts: Record<string, unknown>): Promise<LoginStart>;
  /** OAuth/OIDC: exchange code for tokens and create a session. */
  completeLogin?(opts: Record<string, unknown>): Promise<Session>;

  /** Validate a session access token. */
  verifySession(accessToken: string): Promise<Session | null>;
  /** Refresh a session from its refresh token. */
  refreshSession?(refreshToken: string): Promise<Session | null>;

  /** Password provider: validate credentials and create a session. */
  completePasswordLogin?(username: string, password: string): Promise<Session | null>;

  /** Token provider: validate a raw bearer token and return its principal. */
  verifyToken?(token: string): Promise<TokenPrincipal | null>;
}
