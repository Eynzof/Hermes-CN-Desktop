import { useQuery } from "@tanstack/react-query";
import { resolveSessionIdAliases } from "@/lib/session-map";
import { getUiTurnStats, type UiTurnStats } from "@/lib/ui-store";

const EMPTY_TURN_STATS: UiTurnStats[] = [];

async function fetchSessionTurnStats(taskId: string): Promise<UiTurnStats[]> {
  const aliases = resolveSessionIdAliases(taskId, { includeExpired: true });
  const results = await Promise.all(aliases.map((id) => getUiTurnStats(id)));
  const deduped = new Map<string, UiTurnStats>();
  results.flat().forEach((stat) => deduped.set(stat.id, stat));
  return Array.from(deduped.values()).sort(
    (a, b) =>
      (a.completedAt ?? a.createdAt ?? 0) - (b.completedAt ?? b.createdAt ?? 0) ||
      (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

// 本地 ui-store 的回合统计（TTFT、耗时、tokens）。挂在 TanStack Query 上是
// 为了缓存：旧实现每次切会话都先 setState([]) 再异步 IPC 回填，统计栏总在
// 消息渲染之后才 pop-in，造成一次额外重排。缓存后重访会话时统计与消息同帧
// 渲染。统计只在 message.complete 时写入 ui-store，30s staleTime 不会丢新值
// ——当前回合的实时统计走 runtime 消息自带的 metadata，不依赖这里。
export function useSessionTurnStats(taskId: string | undefined): UiTurnStats[] {
  const query = useQuery<UiTurnStats[]>({
    queryKey: ["ui-turn-stats", taskId],
    enabled: !!taskId,
    staleTime: 30_000,
    queryFn: () => fetchSessionTurnStats(taskId!),
  });
  return query.data ?? EMPTY_TURN_STATS;
}
