import type { GatewayEvent } from "@hermes/protocol";
import { describe, expect, it } from "vitest";
import { gatewayDebugEntryForEvent } from "./debug-install";

describe("gatewayDebugEntryForEvent", () => {
  it("skips empty gateway error events", () => {
    expect(gatewayDebugEntryForEvent({
      type: "error",
      session_id: "6046736a-empty",
    } as GatewayEvent)).toBeNull();

    expect(gatewayDebugEntryForEvent({
      type: "error",
      session_id: "6046736a-empty",
      payload: {},
    } as GatewayEvent)).toBeNull();
  });

  it("keeps gateway error events with details", () => {
    const entry = gatewayDebugEntryForEvent({
      type: "error",
      session_id: "6046736a-message",
      payload: { message: "rate limit exceeded" },
    } as GatewayEvent);

    expect(entry).toMatchObject({
      type: "gateway",
      level: "error",
      payload: {
        type: "error",
      },
    });
    expect(entry?.summary).toContain("sid=6046736a");
    expect(entry?.summary).toContain("rate limit exceeded");
  });

  it("keeps normal gateway events as info", () => {
    const entry = gatewayDebugEntryForEvent({
      type: "gateway.ready",
      payload: { skin: "desktop" },
    } as GatewayEvent);

    expect(entry).toMatchObject({
      type: "gateway",
      level: "info",
      summary: "gateway.ready",
    });
  });
});
