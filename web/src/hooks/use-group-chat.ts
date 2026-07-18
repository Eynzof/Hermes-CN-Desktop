import { useQuery } from "@tanstack/react-query";

import { useGateway } from "./use-gateway";

// Group rooms have gc_-prefixed ids (Core). A ":" marks a per-member
// sub-session, which is never a user-facing room.
export function isGroupRoomId(id: string | null | undefined): boolean {
  return !!id && id.startsWith("gc_") && !id.includes(":");
}

// Fetch a group room's members (name / description / avatar). Backed by the
// gateway groupchat.info RPC, so it survives a page reload — the room lives in
// the gateway process memory, not the session DB.
export function useGroupChatInfo(roomId: string | null | undefined) {
  const { groupChatInfo } = useGateway();
  return useQuery({
    queryKey: ["groupchat-info", roomId],
    enabled: isGroupRoomId(roomId),
    queryFn: () => groupChatInfo(roomId as string),
    staleTime: 60_000,
    retry: false,
  });
}
