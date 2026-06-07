import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { fetchJSON, deleteJSON, postJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { unpinSessions } from "@/lib/session-ui-state";
import {
  MessagesResponse,
  MutationOkResponse,
  SearchResponse,
  SessionDetail,
  SessionsResponse,
  type SearchResult,
} from "@hermes/protocol";

export const DELETE_SESSION_CONCURRENCY = 3;

export interface DeleteSessionsFailure {
  id: string;
  error: string;
}

export interface DeleteSessionsResult {
  requestedIds: string[];
  succeededIds: string[];
  failed: DeleteSessionsFailure[];
  successCount: number;
  failureCount: number;
}

function hasAnyMessages(result: MessagesResponse): boolean {
  return result.ui_messages ? result.ui_messages.length > 0 : result.messages.length > 0;
}

async function fetchSessionLogMessages(id: string): Promise<MessagesResponse | null> {
  try {
    const result = await fetchJSON(
      `/__hermes_session_log/${encodeURIComponent(id)}`,
      undefined,
      MessagesResponse,
    );
    return hasAnyMessages(result) ? result : null;
  } catch {
    return null;
  }
}

async function fetchSessionMessages(id: string): Promise<MessagesResponse> {
  const result = await fetchJSON(
    `/api/sessions/${id}/messages`,
    undefined,
    MessagesResponse,
  );
  if (hasAnyMessages(result)) return result;
  return await fetchSessionLogMessages(id) ?? result;
}

export function useSessions(limit = 50, offset = 0) {
  const profile = useActiveProfileName();
  return useQuery<SessionsResponse>({
    queryKey: ["sessions", profile, limit, offset],
    queryFn: () => fetchJSON(`/api/sessions?limit=${limit}&offset=${offset}`, undefined, SessionsResponse),
  });
}

export function useSession(id: string | undefined) {
  const profile = useActiveProfileName();
  return useQuery<SessionDetail>({
    queryKey: ["session", profile, id],
    queryFn: () => fetchJSON(`/api/sessions/${id}`, undefined, SessionDetail),
    enabled: !!id,
  });
}

export function useSessionMessages(id: string | undefined) {
  const profile = useActiveProfileName();
  return useQuery<MessagesResponse>({
    queryKey: ["session-messages", profile, id],
    queryFn: () => fetchSessionMessages(id!),
    enabled: !!id,
  });
}

export function useSessionSearch(q: string) {
  const profile = useActiveProfileName();
  return useQuery<{ results: SearchResult[] }>({
    queryKey: ["sessions-search", profile, q],
    queryFn: () => fetchJSON(`/api/sessions/search?q=${encodeURIComponent(q)}&limit=20`, undefined, SearchResponse),
    enabled: q.length >= 2,
    staleTime: 10_000,
  });
}

function normalizeSessionIds(ids: Iterable<string>): string[] {
  const seen = new Set<string>();
  return Array.from(ids).flatMap((raw) => {
    const id = raw.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
}

async function deleteSessionRequest(id: string): Promise<void> {
  await deleteJSON(`/api/sessions/${encodeURIComponent(id)}`, undefined, MutationOkResponse);
}

export async function deleteSessionsInBatches(
  ids: Iterable<string>,
  deleteOne: (id: string) => Promise<void> = deleteSessionRequest,
  concurrency = DELETE_SESSION_CONCURRENCY,
): Promise<DeleteSessionsResult> {
  const requestedIds = normalizeSessionIds(ids);
  const succeededIds: string[] = [];
  const failed: DeleteSessionsFailure[] = [];
  const workers = Math.max(1, Math.floor(concurrency));
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (cursor < requestedIds.length) {
      const id = requestedIds[cursor];
      cursor += 1;
      try {
        await deleteOne(id);
        succeededIds.push(id);
      } catch (error) {
        failed.push({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(workers, requestedIds.length) }, () => runWorker()),
  );
  const succeededSet = new Set(succeededIds);
  const failedById = new Map(failed.map((item) => [item.id, item]));
  const orderedSucceededIds = requestedIds.filter((id) => succeededSet.has(id));
  const orderedFailed = requestedIds.flatMap((id) => {
    const item = failedById.get(id);
    return item ? [item] : [];
  });

  return {
    requestedIds,
    succeededIds: orderedSucceededIds,
    failed: orderedFailed,
    successCount: orderedSucceededIds.length,
    failureCount: orderedFailed.length,
  };
}

export function withoutSessions(
  sessions: SessionsResponse | undefined,
  ids: Iterable<string>,
): SessionsResponse | undefined {
  if (!sessions) return sessions;
  const idSet = new Set(normalizeSessionIds(ids));
  if (idSet.size === 0) return sessions;
  const nextSessions = sessions.sessions.filter((session) => !idSet.has(session.id));
  if (nextSessions.length === sessions.sessions.length) return sessions;
  return {
    ...sessions,
    sessions: nextSessions,
    total: Math.max(0, sessions.total - (sessions.sessions.length - nextSessions.length)),
  };
}

export function withoutSearchResults(
  results: { results: SearchResult[] } | undefined,
  ids: Iterable<string>,
): { results: SearchResult[] } | undefined {
  if (!results) return results;
  const idSet = new Set(normalizeSessionIds(ids));
  if (idSet.size === 0) return results;
  const nextResults = results.results.filter((result) => !idSet.has(result.session_id));
  return nextResults.length === results.results.length ? results : { ...results, results: nextResults };
}

function removeDeletedSessionsFromCache(qc: QueryClient, ids: Iterable<string>): void {
  const cleanIds = normalizeSessionIds(ids);
  if (cleanIds.length === 0) return;
  qc.setQueriesData<SessionsResponse>({ queryKey: ["sessions"] }, (data) =>
    withoutSessions(data, cleanIds),
  );
  qc.setQueriesData<{ results: SearchResult[] }>({ queryKey: ["sessions-search"] }, (data) =>
    withoutSearchResults(data, cleanIds),
  );
}

function invalidateSessionLists(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ["sessions"] });
  void qc.invalidateQueries({ queryKey: ["sessions-search"] });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const cleanId = id.trim();
      if (!cleanId) throw new Error("缺少会话 ID");
      await deleteSessionRequest(cleanId);
      return cleanId;
    },
    onSuccess: (id) => {
      unpinSessions([id]);
      removeDeletedSessionsFromCache(qc, [id]);
    },
    onSettled: () => {
      invalidateSessionLists(qc);
    },
  });
}

export function useDeleteSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: Iterable<string>) => deleteSessionsInBatches(ids),
    onSuccess: (result) => {
      if (result.succeededIds.length > 0) {
        unpinSessions(result.succeededIds);
        removeDeletedSessionsFromCache(qc, result.succeededIds);
      }
    },
    onSettled: () => {
      invalidateSessionLists(qc);
    },
  });
}

export function useArchiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      postJSON(`/api/sessions/${encodeURIComponent(id)}/archive`, {}, MutationOkResponse),
    onMutate: async (id) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: ["sessions"] }),
        qc.cancelQueries({ queryKey: ["sessions-search"] }),
      ]);
      const sessionSnapshots = qc.getQueriesData<SessionsResponse>({ queryKey: ["sessions"] });
      const searchSnapshots = qc.getQueriesData<{ results: SearchResult[] }>({
        queryKey: ["sessions-search"],
      });

      qc.setQueriesData<SessionsResponse>({ queryKey: ["sessions"] }, (data) =>
        withoutSessions(data, [id]),
      );
      qc.setQueriesData<{ results: SearchResult[] }>({ queryKey: ["sessions-search"] }, (data) =>
        withoutSearchResults(data, [id]),
      );

      return { sessionSnapshots, searchSnapshots };
    },
    onSuccess: (_result, id) => {
      unpinSessions([id]);
    },
    onError: (_error, _id, context) => {
      for (const [queryKey, data] of context?.sessionSnapshots ?? []) {
        qc.setQueryData(queryKey, data);
      }
      for (const [queryKey, data] of context?.searchSnapshots ?? []) {
        qc.setQueryData(queryKey, data);
      }
    },
    onSettled: () => {
      invalidateSessionLists(qc);
    },
  });
}
