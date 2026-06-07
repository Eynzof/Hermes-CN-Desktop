import type { SessionSummary } from "@hermes/protocol";

export const RECENT_SESSION_LIMIT = 5;

export function lastActivitySec(session: SessionSummary): number {
  return session.ended_at ?? session.started_at;
}

export interface SidebarSessionLists {
  active: SessionSummary[];
  pinned: SessionSummary[];
  recent: SessionSummary[];
}

export function deriveSidebarSessionLists(
  sessions: SessionSummary[],
  pinnedIds: Iterable<string>,
  isRunning: (session: SessionSummary) => boolean,
  recentLimit = RECENT_SESSION_LIMIT,
): SidebarSessionLists {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const pinned = Array.from(pinnedIds).flatMap((id) => {
    const session = sessionById.get(id);
    return session ? [session] : [];
  });
  const pinnedIdSet = new Set(pinned.map((session) => session.id));
  const active: SessionSummary[] = [];
  const recent: SessionSummary[] = [];

  for (const session of sessions) {
    if (isRunning(session)) {
      active.push(session);
    } else if (!pinnedIdSet.has(session.id)) {
      recent.push(session);
    }
  }

  recent.sort((a, b) => lastActivitySec(b) - lastActivitySec(a));
  return {
    active,
    pinned,
    recent: recent.slice(0, recentLimit),
  };
}
