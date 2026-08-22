import { describe, it, expect } from "vitest";
import { buildAcpInitializeResponse, buildAcpError } from "./server.js";
import { AcpSessionManager } from "./session.js";
import { mapAcpDecisionToHermes, PERMISSION_OPTIONS } from "./approval.js";
import { AcpEventBridge } from "./events.js";
import { isAcpTool, ACP_TOOLSET } from "./tools.js";

describe("acp server", () => {
  it("returns initialize response", () => {
    const res = buildAcpInitializeResponse({ jsonrpc: "2.0", id: "1", method: "initialize" });
    expect(res.id).toBe("1");
    expect((res.result as any).serverInfo.name).toBe("hermes-acp");
  });

  it("returns error", () => {
    const res = buildAcpError("2", -32600, "Invalid request");
    expect(res.error?.code).toBe(-32600);
  });
});

describe("acp session", () => {
  it("creates and lists sessions", () => {
    const mgr = new AcpSessionManager();
    mgr.create("s1", { cwd: "/tmp" });
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.get("s1")?.cwd).toBe("/tmp");
  });
});

describe("acp approval", () => {
  it("has permission options", () => {
    expect(PERMISSION_OPTIONS.map((o) => o.id)).toContain("allow_once");
  });

  it("maps decisions", () => {
    expect(mapAcpDecisionToHermes("always")).toBe("always");
    expect(mapAcpDecisionToHermes("timeout")).toBe("deny");
  });
});

describe("acp events", () => {
  it("emits events to subscribers", () => {
    const bridge = new AcpEventBridge();
    const seen: any[] = [];
    bridge.subscribe((e) => seen.push(e));
    bridge.emit({ type: "message", payload: "hi" });
    expect(seen).toHaveLength(1);
  });
});

describe("acp tools", () => {
  it("recognizes ACP tools", () => {
    expect(isAcpTool("read_file")).toBe(true);
    expect(isAcpTool("delegate_task")).toBe(false);
  });

  it("has non-empty toolset", () => {
    expect(ACP_TOOLSET.length).toBeGreaterThan(0);
  });
});
