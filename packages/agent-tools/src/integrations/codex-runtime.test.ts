import { describe, expect, it } from "vitest";
import "./codex-runtime.js";
import { registry } from "../registry.js";

const TOOL_NAMES = ["codex_runtime_toggle", "codex_runtime_status"];

describe("codex_runtime catalog registration", () => {
  it("registers the two codex runtime tools", () => {
    for (const name of TOOL_NAMES) {
      const entry = registry.get(name);
      expect(entry, `expected ${name}`).toBeDefined();
      expect(entry!.toolset).toBe("codex_runtime");
      expect(entry!.handler).toBeTypeOf("function");
    }
  });

  it("codex_runtime_toggle restricts runtime to auto|codex_app_server", () => {
    const schema = registry.get("codex_runtime_toggle")!.schema as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.properties.runtime.enum).toEqual(["auto", "codex_app_server"]);
  });
});

describe("codex_runtime tool dispatch", () => {
  it("toggle reports the selected runtime mode", async () => {
    const res = await registry.dispatch("codex_runtime_toggle", { runtime: "auto" }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("Codex runtime set to auto");
  });

  it("toggle reports undefined for missing runtime (existing behavior)", async () => {
    const res = await registry.dispatch("codex_runtime_toggle", {}, {});
    expect(res.content).toBe("Codex runtime set to undefined");
  });

  it("status returns the stub message", async () => {
    const res = await registry.dispatch("codex_runtime_status", {}, {});
    expect(res.content).toBe("Would report Codex runtime status");
  });
});
