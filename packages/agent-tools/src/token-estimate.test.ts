import { describe, it, expect } from "vitest";
import { countTokens, estimateToolTokens, estimateToolSetTokensSync } from "./token-estimate.js";
import type { ToolDefinition } from "./types.js";

describe("token estimation", () => {
  it("counts tokens without crashing", async () => {
    const n = await countTokens("hello world");
    expect(n).toBeGreaterThan(0);
  });

  it("estimates a single tool", async () => {
    const def: ToolDefinition = {
      type: "function",
      function: {
        name: "foo",
        description: "Does foo.",
        parameters: { type: "object", properties: { x: { type: "string" } } },
      },
    };
    const n = await estimateToolTokens(def);
    expect(n).toBeGreaterThan(0);
  });

  it("sync fallback sums chars/4", () => {
    const defs: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "a",
          description: "abcd",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const n = estimateToolSetTokensSync(defs);
    expect(n).toBeGreaterThan(0);
  });
});
