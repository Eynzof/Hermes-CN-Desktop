import { describe, expect, it } from "vitest";
import { buildNestedConfigUpdate, mergeConfigUpdate } from "./config-update";

describe("config update helpers", () => {
  it("builds a nested patch for dotted schema keys", () => {
    expect(buildNestedConfigUpdate("agent.context_window", 32000)).toEqual({
      agent: { context_window: 32000 },
    });
  });

  it("merges a single field edit into the full config without dropping custom models", () => {
    const current = {
      model: { provider: "custom:local", default: "local-chat" },
      providers: {
        "custom:local": {
          name: "Local",
          base_url: "http://127.0.0.1:11434/v1",
          model: "local-chat",
        },
      },
      agent: { context_window: 16000, image_input_mode: "text" },
    };

    const next = mergeConfigUpdate(
      current,
      buildNestedConfigUpdate("agent.context_window", 64000),
    );

    expect(next).toEqual({
      ...current,
      agent: { context_window: 64000, image_input_mode: "text" },
    });
    expect(next.providers["custom:local"].model).toBe("local-chat");
  });
});
