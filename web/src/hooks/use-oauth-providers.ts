import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, postJSON, deleteJSON } from "@/lib/transport";
import {
  OAuthProvidersResponse,
  OAuthStartResponse,
  OAuthSubmitResponse,
  OAuthPollResponse,
  OAuthDisconnectResponse,
  type OAuthProvider,
} from "@hermes/protocol";

export function useOAuthProviders() {
  return useQuery<OAuthProvider[]>({
    queryKey: ["oauth-providers"],
    queryFn: async ({ signal }) => {
      const res = await fetchJSON("/api/providers/oauth", { signal }, OAuthProvidersResponse);
      return res.providers;
    },
    retry: 1,
    staleTime: 30_000,
  });
}

export function useDisconnectOAuth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) =>
      deleteJSON(
        `/api/providers/oauth/${encodeURIComponent(providerId)}`,
        undefined,
        OAuthDisconnectResponse,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["oauth-providers"] }),
  });
}

export function useStartOAuthLogin() {
  return useMutation({
    mutationFn: (providerId: string) =>
      postJSON(
        `/api/providers/oauth/${encodeURIComponent(providerId)}/start`,
        {},
        OAuthStartResponse,
      ),
  });
}

export function useSubmitOAuthCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { providerId: string; sessionId: string; code: string }) =>
      postJSON(
        `/api/providers/oauth/${encodeURIComponent(vars.providerId)}/submit`,
        { session_id: vars.sessionId, code: vars.code },
        OAuthSubmitResponse,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["oauth-providers"] }),
  });
}

export function usePollOAuthSession(
  providerId: string | null,
  sessionId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["oauth-poll", providerId, sessionId],
    queryFn: ({ signal }) =>
      fetchJSON(
        `/api/providers/oauth/${encodeURIComponent(providerId!)}/poll/${encodeURIComponent(sessionId!)}`,
        { signal },
        OAuthPollResponse,
      ),
    enabled: enabled && !!providerId && !!sessionId,
    refetchInterval: enabled ? 2000 : false,
  });
}

export function useCancelOAuthSession() {
  return useMutation({
    mutationFn: (sessionId: string) =>
      deleteJSON(`/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`),
  });
}
