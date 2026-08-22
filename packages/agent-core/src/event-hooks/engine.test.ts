import { describe, it, expect } from "vitest";
import { EventHookEngine } from "./engine.js";

describe("event-hooks/engine", () => {
  it("matches a hook by event and pattern", () => {
    const engine = new EventHookEngine();
    engine.register({
      id: "h1",
      event: "message",
      pattern: "deploy",
      action: "notify-deploy",
      enabled: true,
    });
    const matches = engine.trigger("message", { text: "please deploy" });
    expect(matches).toHaveLength(1);
    expect(matches[0].action).toBe("notify-deploy");
  });

  it("ignores disabled hooks", () => {
    const engine = new EventHookEngine();
    engine.register({ id: "h1", event: "custom", action: "x", enabled: false });
    expect(engine.trigger("custom", {})).toHaveLength(0);
  });
});
