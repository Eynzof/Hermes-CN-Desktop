import { describe, expect, it } from "vitest";
import { buildAcpError, buildAcpInitializeResponse } from "./server";
import type { AcpServerRequest } from "./types";

describe("buildAcpInitializeResponse", () => {
  it("builds a JSON-RPC 2.0 initialize response that echoes the request id", () => {
    const request: AcpServerRequest = { jsonrpc: "2.0", id: "req-1", method: "initialize" };
    const response = buildAcpInitializeResponse(request);
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe("req-1");
    expect(response.error).toBeUndefined();
  });

  it("advertises the ACP protocol version, capabilities and server info", () => {
    const response = buildAcpInitializeResponse({ jsonrpc: "2.0", id: 7, method: "initialize" });
    expect(response.result).toMatchObject({
      protocolVersion: "0.9.0",
      capabilities: { tools: {}, prompts: {}, resources: {} },
      serverInfo: { name: "hermes-acp", version: "0.1.0" },
    });
  });

  it("keeps numeric ids numeric", () => {
    const response = buildAcpInitializeResponse({ jsonrpc: "2.0", id: 42, method: "initialize" });
    expect(response.id).toBe(42);
  });

  it("handles requests without an id", () => {
    const response = buildAcpInitializeResponse({ jsonrpc: "2.0", method: "initialize" });
    expect(response.id).toBeUndefined();
    expect(response.result).toBeDefined();
  });
});

describe("buildAcpError", () => {
  it("builds a JSON-RPC error response with the given code and message", () => {
    const response = buildAcpError("abc", -32600, "Invalid request");
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe("abc");
    expect(response.result).toBeUndefined();
    expect(response.error).toEqual({ code: -32600, message: "Invalid request" });
  });

  it("uses standard JSON-RPC error codes verbatim", () => {
    expect(buildAcpError("1", -32700, "Parse error").error?.code).toBe(-32700);
    expect(buildAcpError("1", -32601, "Method not found").error?.code).toBe(-32601);
    expect(buildAcpError("1", -32602, "Invalid params").error?.code).toBe(-32602);
  });

  it("propagates numeric and undefined ids", () => {
    expect(buildAcpError(99, -32000, "Server error").id).toBe(99);
    expect(buildAcpError(undefined, -32000, "Server error").id).toBeUndefined();
  });
});
