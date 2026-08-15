import { describe, expect, it } from "vitest";
import type { GatewayEvent } from "@hermes/protocol";
import { gatewayEventChangesSessionList } from "./session-query-sync";

describe("session query sync", () => {
  it.each([
    ["message.complete", true],
    ["error", true],
    ["message.delta", false],
    ["tool.progress", false],
  ])("classifies %s session-list invalidation", (type, expected) => {
    expect(gatewayEventChangesSessionList({ type } as GatewayEvent)).toBe(expected);
  });
});
