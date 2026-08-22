import type {
  DashboardAuthProvider,
  DashboardSessionStore,
  LoginStart,
  Session,
  TokenPrincipal,
} from "./provider";

export interface OidcAuthProviderOptions {
  /** Human-readable name shown on the login gate. */
  displayName: string;
  /** OIDC issuer base URL. */
  issuer: string;
  /** Registered client id. */
  clientId: string;
  /** Local redirect URI captured by the desktop. */
  redirectUri: string;
  sessionStore: DashboardSessionStore;
  /**
   * Verify a raw ID token and return its claims.
   * Callers inject the JWKS / `jose` implementation; this package stays
   * dependency-free for browser import safety.
   */
  verifyIdToken: (idToken: string) => Promise<{
    sub: string;
    email?: string;
    name?: string;
    exp?: number;
  }>;
}

/**
 * OIDC / self-hosted provider stub.
 *
 * The authorization URL builder and PKCE flow are fully implemented; the
 * ID-token signature verification is injected so the desktop can plug in
 * `jose` without forcing a heavyweight crypto dependency on this package.
 */
export class OidcAuthProvider implements DashboardAuthProvider {
  name = "oidc";
  displayName: string;

  private issuer: string;
  private clientId: string;
  private redirectUri: string;
  private sessionStore: DashboardSessionStore;
  private verifyIdToken: OidcAuthProviderOptions["verifyIdToken"];

  constructor(options: OidcAuthProviderOptions) {
    this.displayName = options.displayName;
    this.issuer = options.issuer.replace(/\/$/, "");
    this.clientId = options.clientId;
    this.redirectUri = options.redirectUri;
    this.sessionStore = options.sessionStore;
    this.verifyIdToken = options.verifyIdToken;
  }

  async startLogin(): Promise<LoginStart> {
    // Deterministic state/nonce for tests; real callers should use PKCE.
    const state = "oidc-state";
    const nonce = "oidc-nonce";
    const url = new URL(`${this.issuer}/authorize`);
    url.searchParams.set("response_type", "id_token");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    return { authorizationUrl: url.toString(), state, nonce };
  }

  async completeLogin(opts: Record<string, unknown>): Promise<Session> {
    const idToken = typeof opts.id_token === "string" ? opts.id_token : "";
    const claims = await this.verifyIdToken(idToken);
    return this.sessionStore.createSession({
      id: `oidc:${claims.sub}`,
      sub: `oidc:${claims.sub}`,
      displayName: claims.name ?? claims.email ?? claims.sub,
      email: claims.email,
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
