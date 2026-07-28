import type { QueryClient } from "@tanstack/react-query";
import type { GatewayEvent } from "@hermes/protocol";

/** Refresh every cached session-list variant (sidebar, history, archived). */
export function invalidateSessionListQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ["sessions"] });
}

/** Gateway terminal events persist status, token totals and the final preview. */
export function gatewayEventChangesSessionList(event: GatewayEvent): boolean {
  return event.type === "message.complete" || event.type === "error";
}
