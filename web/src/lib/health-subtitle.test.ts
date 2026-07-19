import { describe, expect, it } from "vitest";
import { formatHealthSubtitle } from "./health-subtitle";

function status(overrides: Partial<Parameters<typeof formatHealthSubtitle>[0]> = {}) {
  return {
    gateway_running: false,
    gateway_state: "",
    version: "0.15.2",
    ...overrides,
  };
}

describe("formatHealthSubtitle", () => {
  it("uses human-readable states instead of exposing raw unknown", () => {
    expect(formatHealthSubtitle(status({ gateway_state: "unknown" }), false)).toBe("内核就绪 · v0.15.2");
    expect(formatHealthSubtitle(status({ gateway_state: "" }), false)).toBe("内核就绪 · v0.15.2");
    expect(formatHealthSubtitle(status({ gateway_state: "stopped" }), false)).toBe("内核就绪 · v0.15.2");
  });

  it("keeps clear labels for loading, offline, and running states", () => {
    expect(formatHealthSubtitle(undefined, false)).toBe("加载中…");
    expect(formatHealthSubtitle(status(), true)).toBe("内核离线");
    expect(formatHealthSubtitle(status({ gateway_running: true }), false)).toBe("网关运行中 · v0.15.2");
  });
});
