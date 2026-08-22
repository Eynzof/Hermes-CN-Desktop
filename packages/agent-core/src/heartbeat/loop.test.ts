import { describe, it, expect } from "vitest";
import { HeartbeatLoop } from "./loop.js";

describe("heartbeat/loop", () => {
  it("sets and fires a heartbeat", async () => {
    const submitted: string[] = [];
    const loop = new HeartbeatLoop(async (_sessionId, prompt) => {
      submitted.push(prompt);
    });
    loop.set("s1", "1m", "check status");
    const now = Date.now();
    await loop.tick(now + 60_001);
    expect(submitted).toEqual(["check status"]);
  });

  it("cancels heartbeat", () => {
    const loop = new HeartbeatLoop(async () => {});
    loop.set("s1", "5m", "x");
    expect(loop.cancel("s1")).toContain("cancelled");
  });
});
