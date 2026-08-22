import type { GoogleOAuthTokenState } from "@hermes/protocol";

export interface MeetToolContext {
  sessionId?: string;
  env?: Record<string, string | undefined>;
  /** Rust IPC invoker. */
  invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Optional injected OAuth state for tests. */
  googleOAuth?: {
    getState: () => Promise<GoogleOAuthTokenState | null | undefined>;
    saveState: (state: GoogleOAuthTokenState) => Promise<void>;
  };
}
