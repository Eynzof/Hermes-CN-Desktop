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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchSessionLogMessages(id: string, signal?: AbortSignal): Promise<MessagesResponse | null> {
  try {
    const result = await fetchJSON(
      `/__hermes_session_log/${encodeURIComponent(id)}`,
      { signal },
      MessagesResponse,
    );
    return hasAnyMessages(result) ? result : null;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}

export async function fetchSessionMessages(id: string, signal?: AbortSignal): Promise<MessagesResponse> {
  let result: MessagesResponse;
  try {
    result = await fetchJSON(
      `/api/sessions/${id}/messages`,
      { signal },
      MessagesResponse,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    // 主端点 404（会话 id 形态与后端不一致 / 尚未落盘等）会让 fetchJSON 直接 throw，
    // 之前不会触发下面的会话日志兜底，导致历史整段丢失。先退回 /__hermes_session_log，
    // 拿不到再把原始错误抛给 React Query。
    const fallback = await fetchSessionLogMessages(id, signal);
    if (fallback) return fallback;
    throw error;
  }
  if (hasAnyMessages(result)) return result;
  return await fetchSessionLogMessages(id, signal) ?? result;
}

export interface UseSessionsOptions {
  // When true, ask the Rust proxy to keep archived sessions (annotated with
  // `archived: true`) instead of stripping them. Defaults to false so the
  // sidebar and other callers keep the active-only list. See history page.
  includeArchived?: boolean;
}

export function useSessions(limit = 50, offset = 0, opts: UseSessionsOptions = {}) {
  const profile = useActiveProfileName();
  const includeArchived = opts.includeArchived ?? false;
  return useQuery<SessionsResponse>({
    queryKey: ["sessions", profile, limit, offset, includeArchived ? "all" : "active"],
    queryFn: ({ signal }) =>
      fetchJSON(
        `/api/sessions?limit=${limit}&offset=${offset}${includeArchived ? "&include_archived=true" : ""}`,
        { signal },
        SessionsResponse,
      ),
  });
}

export function useSession(id: string | undefined) {
  const profile = useActiveProfileName();
  return useQuery<SessionDetail>({
    queryKey: ["session", profile, id],
    queryFn: ({ signal }) => fetchJSON(`/api/sessions/${id}`, { signal }, SessionDetail),
    enabled: !!id,
  });
}

// 消息列表是切会话时详情页首屏的关键路径：30s 内重访直接渲染缓存（后台仍
// refetch 校准），不再每次切换都回退到「加载对话中…」占位。运行中会话的实时
// 内容走 Jotai runtime bucket，不依赖这里的新鲜度。
export const SESSION_MESSAGES_STALE_TIME_MS = 30_000;

export function useSessionMessages(id: string | undefined) {
  const profile = useActiveProfileName();
  return useQuery<MessagesResponse>({
    queryKey: ["session-messages", profile, id],
    queryFn: ({ signal }) => fetchSessionMessages(id!, signal),
    enabled: !!id,
    staleTime: SESSION_MESSAGES_STALE_TIME_MS,
  });
}

// 侧边栏 / 历史列表 hover 时预取，点击进入详情页时数据已在缓存或在途。
// prefetchQuery 对未过期数据是 no-op，hover 抖动不会放大后端压力。
export function prefetchSessionMessages(
  qc: QueryClient,
  profile: string,
  id: string | undefined,
): void {
  if (!id) return;
  void qc.prefetchQuery({
    queryKey: ["session-messages", profile, id],
    queryFn: ({ signal }) => fetchSessionMessages(id, signal),
    staleTime: SESSION_MESSAGES_STALE_TIME_MS,
  });
}

export function useSessionSearch(q: string) {
  const profile = useActiveProfileName();
  return useQuery<{ results: SearchResult[] }>({
    queryKey: ["sessions-search", profile, q],
    queryFn: ({ signal }) => fetchJSON(`/api/sessions/search?q=${encodeURIComponent(q)}&limit=20`, { signal }, SearchResponse),
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

// Inverse of useArchiveSession: DELETE /api/sessions/{id}/archive un-archives a
// session (see handle_archive_request DELETE branch). The mutation optimistically
// drops the row from the archived view; onSettled re-fetches so it reappears in
// the active list. The caller is on the archived scope, so the brief removal is
// only ever observed where the row should disappear.
export function useUnarchiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      deleteJSON(`/api/sessions/${encodeURIComponent(id)}/archive`, undefined, MutationOkResponse),
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
