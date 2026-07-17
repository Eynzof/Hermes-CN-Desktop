import { describe, expect, it } from "vitest";
import { canCompleteGuide, productModeForConnection } from "./guide-state";

describe("guide state", () => {
  it("maps the compatible three transport modes into two product modes", () => {
    expect(productModeForConnection("managed")).toBe("managed");
    expect(productModeForConnection("local")).toBe("external");
    expect(productModeForConnection("remote")).toBe("external");
  });

  it("requires backend HTTP, WebSocket and a current model before completion", () => {
    expect(canCompleteGuide({ backendReady: true, dashboardHttpOk: true, gatewayWsOk: true, hasCurrentModel: true })).toBe(true);
    expect(canCompleteGuide({ backendReady: true, dashboardHttpOk: true, gatewayWsOk: false, hasCurrentModel: true })).toBe(false);
    expect(canCompleteGuide({ backendReady: false, dashboardHttpOk: false, gatewayWsOk: false, hasCurrentModel: false })).toBe(false);
  });
});
