import type {
  DashboardAuthProvider,
  DashboardSessionStore,
  Session,
  TokenPrincipal,
} from "./provider";

export interface BasicAuthProviderOptions {
  /** Username → password hash map. */
  users: Record<string, string>;
  sessionStore: DashboardSessionStore;
  /** Compare a plaintext password to a stored hash. */
  verifyPassword: (password: string, hash: string) => Promise<boolean>;
  /** Hash a plaintext password (used during registration, not login). */
  hashPassword?: (password: string) => Promise<string>;
}

/**
 * Username/password auth provider.
 *
 * Password hashing/verification is injected so callers can use Node crypto,
 * Web Crypto, or deterministic test fixtures without a hard dependency.
 */
export class BasicAuthProvider implements DashboardAuthProvider {
  name = "basic";
  displayName = "用户名 / 密码";
  supportsPassword = true;

  private users: Record<string, string>;
  private sessionStore: DashboardSessionStore;
  private verifyPassword: (password: string, hash: string) => Promise<boolean>;
  private hashPassword?: (password: string) => Promise<string>;

  constructor(options: BasicAuthProviderOptions) {
    this.users = options.users;
    this.sessionStore = options.sessionStore;
    this.verifyPassword = options.verifyPassword;
    this.hashPassword = options.hashPassword;
  }

  async completePasswordLogin(username: string, password: string): Promise<Session | null> {
    const hash = this.users[username];
    if (!hash) return null;
    const ok = await this.verifyPassword(password, hash);
    if (!ok) return null;
    return this.sessionStore.createSession({
      displayName: username,
      sub: `basic:${username}`,
      scopes: ["dashboard"],
    });
  }

  async verifySession(accessToken: string): Promise<Session | null> {
    const principal = await this.sessionStore.verifyAccessToken(accessToken);
    if (!principal) return null;
    const session = await this.sessionStore.getSession(principal.sub);
    if (!session) return null;
    return { ...session, accessToken };
  }

  async verifyToken(token: string): Promise<TokenPrincipal | null> {
    return this.sessionStore.verifyAccessToken(token);
  }
}
