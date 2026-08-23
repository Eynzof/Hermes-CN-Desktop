import { describe, expect, it } from "vitest";
import {
  sanitizeMcpToolName,
  mcpToolName,
  StubMcpConnectionManager,
} from "./mcp.js";

describe("sanitizeMcpToolName", () => {
  it("keeps alphanumeric, underscore and dash names", () => {
    expect(sanitizeMcpToolName("read-file")).toBe("read-file");
    expect(sanitizeMcpToolName("my_tool_2")).toBe("my_tool_2");
    expect(sanitizeMcpToolName("plain")).toBe("plain");
  });

  it("replaces invalid characters with underscores", () => {
    expect(sanitizeMcpToolName("read file!")).toBe("read_file_");
    expect(sanitizeMcpToolName("a.b/c")).toBe("a_b_c");
    expect(sanitizeMcpToolName("")).toBe("");
  });

  it("replaces non-ASCII/unicode characters", () => {
    expect(sanitizeMcpToolName("文件")).toBe("__");
  });

  it("truncates names to 64 chars", () => {
    const long = "x".repeat(100);
    expect(sanitizeMcpToolName(long)).toHaveLength(64);
    expect(sanitizeMcpToolName(long)).toBe("x".repeat(64));
  });
});

describe("mcpToolName", () => {
  it("builds the mcp__server__tool qualified name", () => {
    expect(mcpToolName("github", "star")).toBe("mcp__github__star");
  });

  it("sanitizes the tool part but keeps the server verbatim", () => {
    expect(mcpToolName("github", "read file")).toBe("mcp__github__read_file");
  });
});

describe("StubMcpConnectionManager", () => {
  it("connect() records a connected stdio server", async () => {
    const mgr = new StubMcpConnectionManager();
    const server = await mgr.connect("filesystem");
    expect(server.name).toBe("filesystem");
    expect(server.transport).toBe("stdio");
    expect(server.enabled).toBe(true);
    expect(server.status).toBe("connected");
    expect(server.tools).toEqual([]);
    expect(mgr.servers).toHaveLength(1);
  });

  it("disconnect() removes the server by name", async () => {
    const mgr = new StubMcpConnectionManager();
    await mgr.connect("a");
    await mgr.connect("b");
    await mgr.disconnect("a");
    expect(mgr.servers.map((s) => s.name)).toEqual(["b"]);
    // Disconnecting an unknown name is a no-op.
    await expect(mgr.disconnect("nope")).resolves.toBeUndefined();
  });

  it("listTools() returns an empty list", async () => {
    const mgr = new StubMcpConnectionManager();
    await expect(mgr.listTools("any")).resolves.toEqual([]);
  });
});
