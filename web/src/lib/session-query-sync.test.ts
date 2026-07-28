import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { GatewayEvent } from "@hermes/protocol";
import {
  gatewayEventChangesSessionList,
  invalidateSessionListQueries,
} from "./session-query-sync";

describe("session query sync", () => {
  it("invalidates every session-list query variant", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);

    await invalidateSessionListQueries(queryClient);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sessions"] });
  });

  it.each([
    ["message.complete", true],
    ["error", true],
    ["message.delta", false],
    ["tool.progress", false],
  ])("classifies %s session-list invalidation", (type, expected) => {
    expect(gatewayEventChangesSessionList({ type } as GatewayEvent)).toBe(expected);
  });
});
