import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { SpotifyTokenState } from "@hermes/protocol";
import {
  buildSpotifyAuthUrl,
  startSpotifyCallbackListener,
  waitForSpotifyCallback,
  completeSpotifyLogin,
  disconnectSpotify,
  getSpotifyLoginStatus,
  refreshSpotifyToken,
  cancelSpotifyCallback,
  openSpotifyAuthUrl,
  DEFAULT_SPOTIFY_REDIRECT_URI,
} from "@/lib/spotify";
import type { SpotifyLoginInput } from "@/lib/spotify";
export type { SpotifyLoginInput };
import { notifyConnectionAuthRestored } from "@/lib/connection-auth-events";

const SPOTIFY_STATUS_KEY = ["spotify", "status"];

export function useSpotifyStatus() {
  return useQuery<SpotifyTokenState | null>({
    queryKey: SPOTIFY_STATUS_KEY,
    queryFn: getSpotifyLoginStatus,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useSpotifyLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SpotifyLoginInput) => {
      const { authUrl, codeVerifier, state } = await buildSpotifyAuthUrl(input);
      const { redirectUri } = await startSpotifyCallbackListener(input.redirectUri
        ? new URL(input.redirectUri).port
          ? Number(new URL(input.redirectUri).port)
          : undefined
        : undefined);
      await openSpotifyAuthUrl(authUrl);
      const callback = await waitForSpotifyCallback();
      if (callback.state !== state) {
        await cancelSpotifyCallback();
        throw new Error("OAuth state mismatch");
      }
      const tokenState = await completeSpotifyLogin(
        { ...input, redirectUri },
        callback.code,
        codeVerifier,
      );
      return tokenState;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SPOTIFY_STATUS_KEY });
      notifyConnectionAuthRestored();
    },
  });
}

export function useSpotifyDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: disconnectSpotify,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SPOTIFY_STATUS_KEY });
      notifyConnectionAuthRestored();
    },
  });
}

export function useSpotifyRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: refreshSpotifyToken,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SPOTIFY_STATUS_KEY });
    },
  });
}

export function useSpotifyExpiry() {
  const { data: state } = useSpotifyStatus();
  return useCallback(() => {
    if (!state?.expires_at) return null;
    const ms = Date.parse(state.expires_at);
    if (Number.isNaN(ms)) return null;
    return ms;
  }, [state]);
}
