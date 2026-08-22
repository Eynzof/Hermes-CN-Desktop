import type { SpotifyTokenState } from "@hermes/protocol";
import type { ToolContext } from "../types.js";

export interface SpotifyToolContext extends ToolContext {
  env?: {
    spotify_access_token?: string;
    spotify_refresh_token?: string;
    spotify_client_id?: string;
    spotify_redirect_uri?: string;
    spotify_accounts_base_url?: string;
    spotify_api_base_url?: string;
    spotify_scope?: string;
    spotify_expires_at?: string;
    spotify_token_type?: string;
  };
  /** Injected by the runtime to retrieve/store full token state. */
  spotify?: {
    getState: () => Promise<SpotifyTokenState | null>;
    saveState: (state: SpotifyTokenState) => Promise<void>;
  };
}
