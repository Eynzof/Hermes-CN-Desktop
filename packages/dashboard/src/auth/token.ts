import type {
  DashboardAuthProvider,
  DashboardSessionStore,
  Session,
  TokenPrincipal,
} from "./provider";

export interface TokenAuthProviderOptions {
  /** Static secret used to validate raw bearer tokens. */
  secret: string;
  sessionStore: DashboardSessionStore;
  /** Optional claim extractor (defaults to treating the token as the subject). */
  extractPrincipal?: (token: string) => TokenPrincipal | null;
}

/**
 * Static bearer-token auth provider.
 *
 * Useful for headless/API access and for the desktop's own managed-runtime
 * token gate. The provider does not implement a login flow; it only validates
 * opaque tokens.
 */
export class TokenAuthProvider implements DashboardAuthProvider {
  name = "token";
  displayName = "访问令牌";
  supportsToken = true;

  private secret: string;
  private sessionStore: DashboardSessionStore;
  private extractPrincipal: (token: string) => TokenPrincipal | null;

  constructor(options: TokenAuthProviderOptions) {
    this.secret = options.secret;
    this.sessionStore = options.sessionStore;
    this.extractPrincipal =
      options.extractPrincipal ??
      ((token) => (token.startsWith(this.secret) ? { sub: "service" } : null));
  }

  async verifyToken(token: string): Promise<TokenPrincipal | null> {
    return this.extractPrincipal(token);
  }

  async verifySession(accessToken: string): Promise<Session | null> {
    const principal = await this.verifyToken(accessToken);
    if (!principal) return null;
    const session = await this.sessionStore.getSession(principal.sub);
    if (!session) return null;
    return { ...session, accessToken };
  }
}
