import { describe, it, expect, vi } from "vitest";
import { CodexClient } from "./client.js";
import { CodexSessionManager } from "./session.js";
import { projectItemEvent, deterministicCallId } from "./projector.js";
import { CodexEventBridge } from "./event-bridge.js";
import { recordCodexUsage } from "./usage.js";
import { parseCodexRuntime, getDefaultRuntime, buildCodexRuntimeStatus } from "./toggle.js";
import { migrateCodexConfig, renderManagedConfigToml } from "./migration.js";
import { getCodexModelIds, DEFAULT_CODEX_MODELS } from "./models.js";
import { isHermesToolsMcpTool, HERMES_TOOLS_MCP_ALLOWLIST } from "./hermes-tools-mcp.js";
import { shouldUseCodexAppServer } from "./runtime-dispatcher.js";

describe("codex client", () => {
  it("invokes commands", async () => {
    const invoke = vi.fn().mockResolvedValue(true);
    const listen = vi.fn().mockResolvedValue(() => {});
    const client = new CodexClient({ invoke, listen });
    await client.checkBinary();
    expect(invoke).toHaveBeenCalledWith("codex_app_server_check");
  });
});

describe("codex session", () => {
  it("records thread id", () => {
    const mgr = new CodexSessionManager();
    const session = mgr.create("s1");
    mgr.recordTurn("s1", { threadId: "t1", toolIterations: 0, interrupted: false, projectedMessages: [] });
    expect(session.threadId).toBe("t1");
  });
});

describe("codex projector", () => {
  it("projects agent message", () => {
    const msgs = projectItemEvent({ type: "item/agentMessage", delta: "hi" });
    expect(msgs[0].role).toBe("assistant");
  });

  it("generates deterministic call id", () => {
    expect(deterministicCallId("s", "t", 0)).toBe("s_t_0");
  });
});

describe("codex event bridge", () => {
  it("emits mapped events", () => {
    const bridge = new CodexEventBridge();
    const seen: any[] = [];
    bridge.subscribe((e) => seen.push(e));
    bridge.emit({ type: "item/started" });
    expect(seen).toHaveLength(1);
  });
});

describe("codex usage", () => {
  it("records usage", () => {
    const usage = recordCodexUsage(100, 10);
    expect(usage.outputTokens).toBe(10);
  });
});

describe("codex toggle", () => {
  it("parses runtime", () => {
    expect(parseCodexRuntime("codex_app_server")).toBe("codex_app_server");
  });

  it("builds status", () => {
    expect(buildCodexRuntimeStatus(getDefaultRuntime(), true).binaryOk).toBe(true);
  });
});

describe("codex migration", () => {
  it("renders managed toml", () => {
    const toml = renderManagedConfigToml([{ name: "m1" }], [{ name: "p1" }]);
    expect(toml).toContain("managed by hermes-agent");
  });

  it("migrates config", () => {
    expect(migrateCodexConfig([{}], [{}, {}])).toEqual({ mcpServers: 1, plugins: 2, errors: [] });
  });
});

describe("codex models", () => {
  it("returns defaults", async () => {
    const models = await getCodexModelIds();
    expect(models.length).toBe(DEFAULT_CODEX_MODELS.length);
  });
});

describe("codex hermes-tools mcp", () => {
  it("recognizes allowlisted tools", () => {
    expect(isHermesToolsMcpTool("web_search")).toBe(true);
    expect(isHermesToolsMcpTool("delegate_task")).toBe(false);
  });

  it("has allowlist", () => {
    expect(HERMES_TOOLS_MCP_ALLOWLIST.length).toBeGreaterThan(0);
  });
});

describe("codex runtime dispatcher", () => {
  it("routes when runtime is codex_app_server and provider matches", () => {
    expect(shouldUseCodexAppServer("codex_app_server", "openai")).toBe(true);
    expect(shouldUseCodexAppServer("auto", "openai")).toBe(false);
  });
});
