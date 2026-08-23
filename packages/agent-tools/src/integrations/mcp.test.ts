import { describe, expect, it } from "vitest";
import "./mcp.js";
import { registry } from "../registry.js";

const TOOL_NAMES = ["mcp_server_add", "mcp_server_remove", "mcp_server_list", "mcp_server_test"];

describe("mcp integration catalog registration", () => {
  it("registers the four MCP server management tools", () => {
    for (const name of TOOL_NAMES) {
      const entry = registry.get(name);
      expect(entry, `expected ${name}`).toBeDefined();
      expect(entry!.toolset).toBe("mcp");
      expect(entry!.handler).toBeTypeOf("function");
    }
  });

  it("mcp_server_add schema enumerates transports", () => {
    const schema = registry.get("mcp_server_add")!.schema;
    const transport = schema.properties?.transport as { enum?: string[] } | undefined;
    expect(transport?.enum).toEqual(["stdio", "sse", "http"]);
    // objectSchema marks every declared key as required by default.
    expect(schema.required).toEqual(["name", "transport", "command", "args", "url", "enabled"]);
    expect(schema.properties?.args).toMatchObject({ type: "array" });
  });
});

describe("mcp integration tool dispatch", () => {
  it("mcp_server_add echoes the full configuration", async () => {
    const res = await registry.dispatch(
      "mcp_server_add",
      { name: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      {},
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content);
    expect(parsed.name).toBe("github");
    expect(parsed.transport).toBe("stdio");
    expect(parsed.command).toBe("npx");
    expect(parsed.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
  });

  it("mcp_server_remove echoes the server name", async () => {
    const res = await registry.dispatch("mcp_server_remove", { name: "github" }, {});
    expect(JSON.parse(res.content).name).toBe("github");
  });

  it("mcp_server_list handles missing args gracefully", async () => {
    const res = await registry.dispatch("mcp_server_list", undefined, {});
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("{}");
  });

  it("mcp_server_test echoes the server name", async () => {
    const res = await registry.dispatch("mcp_server_test", { name: "filesystem" }, {});
    expect(JSON.parse(res.content).name).toBe("filesystem");
  });
});
