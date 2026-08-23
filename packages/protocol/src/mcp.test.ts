import { describe, expect, it } from "vitest";
import {
  McpCatalogEntrySchema,
  McpServerConfigSchema,
  McpServerEntrySchema,
  McpServerStatusSchema,
  McpTestResultSchema,
  McpToolCallRequestSchema,
  McpTransportType,
} from "./mcp";

describe("McpTransportType", () => {
  it("accepts stdio, sse and http", () => {
    for (const t of ["stdio", "sse", "http"]) {
      expect(McpTransportType.parse(t)).toBe(t);
    }
  });

  it("rejects unknown transports", () => {
    expect(McpTransportType.safeParse("websocket").success).toBe(false);
  });
});

describe("McpServerConfigSchema", () => {
  it("parses a minimal stdio server config", () => {
    const parsed = McpServerConfigSchema.parse({ name: "fs", transport: "stdio" });
    expect(parsed.enabled).toBe(true);
    expect(parsed.command).toBeUndefined();
  });

  it("parses a full server config", () => {
    const parsed = McpServerConfigSchema.parse({
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { FOO: "bar" },
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
      tools: { include: ["read"], exclude: ["write"] },
      lazy: true,
      enabled: false,
    });
    expect(parsed.command).toBe("npx");
    expect(parsed.tools?.include).toEqual(["read"]);
    expect(parsed.lazy).toBe(true);
    expect(parsed.enabled).toBe(false);
  });

  it("rejects a missing name or invalid transport", () => {
    expect(McpServerConfigSchema.safeParse({ transport: "stdio" }).success).toBe(false);
    expect(McpServerConfigSchema.safeParse({ name: "x", transport: "tcp" }).success).toBe(false);
  });
});

describe("McpServerStatusSchema", () => {
  it("accepts every status value", () => {
    for (const s of ["pending", "connecting", "connected", "failed", "disabled", "needs-auth"]) {
      expect(McpServerStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects unknown statuses", () => {
    expect(McpServerStatusSchema.safeParse("auth").success).toBe(false);
  });
});

describe("McpServerEntrySchema", () => {
  it("parses an entry and defaults toolCount/error", () => {
    const parsed = McpServerEntrySchema.parse({
      name: "fs",
      config: { name: "fs", transport: "stdio" },
      status: "connected",
    });
    expect(parsed.toolCount).toBe(0);
    expect(parsed.error).toBeNull();
  });

  it("keeps explicit toolCount and error", () => {
    const parsed = McpServerEntrySchema.parse({
      name: "fs",
      config: { name: "fs", transport: "stdio" },
      status: "failed",
      toolCount: 3,
      error: "spawn failed",
    });
    expect(parsed.toolCount).toBe(3);
    expect(parsed.error).toBe("spawn failed");
  });

  it("rejects a missing config or invalid status", () => {
    expect(
      McpServerEntrySchema.safeParse({ name: "x", status: "connected" }).success,
    ).toBe(false);
    expect(
      McpServerEntrySchema.safeParse({
        name: "x",
        config: { name: "x", transport: "stdio" },
        status: "bogus",
      }).success,
    ).toBe(false);
  });
});

describe("McpTestResultSchema", () => {
  it("parses ok results with optional tools", () => {
    const parsed = McpTestResultSchema.parse({ ok: true, message: "ok", tools: ["read"] });
    expect(parsed.tools).toEqual(["read"]);
    expect(McpTestResultSchema.parse({ ok: false, message: "fail" }).tools).toBeUndefined();
  });

  it("rejects a missing message", () => {
    expect(McpTestResultSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

describe("McpCatalogEntrySchema", () => {
  it("parses catalog entries with optional publisher/installCommand", () => {
    const parsed = McpCatalogEntrySchema.parse({
      name: "fs",
      description: "Filesystem access",
      publisher: "modelcontextprotocol",
      installCommand: "npx -y @modelcontextprotocol/server-filesystem",
    });
    expect(parsed.publisher).toBe("modelcontextprotocol");
    expect(McpCatalogEntrySchema.parse({ name: "a", description: "b" }).installCommand).toBeUndefined();
  });

  it("rejects a missing name", () => {
    expect(McpCatalogEntrySchema.safeParse({ description: "b" }).success).toBe(false);
  });
});

describe("McpToolCallRequestSchema", () => {
  it("parses tool call requests with optional arguments", () => {
    const parsed = McpToolCallRequestSchema.parse({
      server: "fs",
      tool: "read_file",
      arguments: { path: "/tmp/a.txt" },
    });
    expect(parsed.arguments).toEqual({ path: "/tmp/a.txt" });
    expect(McpToolCallRequestSchema.parse({ server: "fs", tool: "list" }).arguments).toBeUndefined();
  });

  it("rejects a missing server or tool", () => {
    expect(McpToolCallRequestSchema.safeParse({ tool: "read" }).success).toBe(false);
    expect(McpToolCallRequestSchema.safeParse({ server: "fs" }).success).toBe(false);
  });
});
