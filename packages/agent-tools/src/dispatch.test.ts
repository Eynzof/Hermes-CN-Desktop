import { describe, it, expect } from "vitest";
import { handleToolCall } from "./dispatch.js";
import { registry } from "./registry.js";
import type { ToolEntry } from "./types.js";

const nativeEntry: ToolEntry = {
  name: "native_echo",
  toolset: "test",
  schema: { type: "object", properties: { msg: { type: "string" } } },
  handler: async (args) => ({ content: String((args as { msg: string }).msg) }),
};

describe("handleToolCall", () => {
  it("routes to native handler", async () => {
    registry.register(nativeEntry);
    const out = await handleToolCall("native_echo", { msg: "hi" }, { sessionId: "s1" });
    expect(out.result.content).toBe("hi");
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("uses Rust IPC fallback for OS-level tools", async () => {
    const invoke = async (_cmd: string, args: Record<string, unknown>) => ({
      content: `ipc:${(args.name as string) ?? ""}`,
    });
    const out = await handleToolCall("file_read", { path: "/tmp/x" }, { sessionId: "s1" }, { invoke });
    expect(out.result.content).toContain("ipc:file_read");
  });

  it("returns error when no invoker available", async () => {
    const out = await handleToolCall("file_read", { path: "/tmp/x" }, { sessionId: "s1" });
    expect(out.result.isError).toBe(true);
  });

  it("forceNative bypasses IPC allowlist", async () => {
    const out = await handleToolCall(
      "file_read",
      { path: "/tmp/x" },
      { sessionId: "s1" },
      { forceNative: true },
    );
    // native file_read returns an error placeholder because we are in node/browser
    expect(out.result.content).toContain("Would read file");
  });
});
