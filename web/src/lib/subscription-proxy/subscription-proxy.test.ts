import { describe, it, expect } from "vitest";
import type { ProxyStatus } from "./types.js";

describe("subscription proxy types", () => {
  it("has a valid status shape", () => {
    const status: ProxyStatus = { running: true, port: 8645, provider: "nous", authenticated: false };
    expect(status.port).toBe(8645);
  });
});
