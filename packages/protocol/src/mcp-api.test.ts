import { describe, expect, it } from "vitest";
import {
  McpCatalogInstallResponse,
  McpCatalogResponse,
  McpEnabledResponse,
  McpServer,
  McpServerCreate,
  McpServersFullResponse,
  McpTestResult,
} from "./hermes-api";

// 这些 payload 对齐 Hermes-CN-Core/hermes_cli/web_server.py 里 /api/mcp/* 各
// handler 的真实输出（_mcp_server_summary / test / catalog / install），用于
// 锁定桌面版与官方上游接口之间的契约。

describe("McpServersFullResponse (GET /api/mcp/servers)", () => {
  it("parses http + stdio servers as returned by _mcp_server_summary", () => {
    const payload = {
      servers: [
        {
          name: "remote-api",
          transport: "http",
          url: "https://example.com/mcp",
          command: null,
          args: [],
          env: {},
          auth: "oauth",
          enabled: true,
          tools: null,
        },
        {
          name: "smoke-fs",
          transport: "stdio",
          url: null,
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          // 后端会脱敏 env 值，这里仍是字符串。
          env: { SAMPLE_KEY: "sk-***redacted***" },
          auth: null,
          enabled: false,
          tools: ["read_file", "write_file"],
        },
      ],
    };
    const parsed = McpServersFullResponse.parse(payload);
    expect(parsed.servers).toHaveLength(2);
    expect(parsed.servers[0].transport).toBe("http");
    expect(parsed.servers[1].args).toContain("/tmp");
    expect(parsed.servers[1].enabled).toBe(false);
  });

  it("single McpServer matches the POST /api/mcp/servers response", () => {
    const added = McpServer.parse({
      name: "added",
      transport: "stdio",
      command: "uvx",
      args: ["some-server"],
      env: {},
      enabled: true,
      tools: null,
    });
    expect(added.command).toBe("uvx");
  });
});

describe("McpTestResult (POST /api/mcp/servers/{name}/test)", () => {
  it("parses a successful probe (no error key)", () => {
    const ok = McpTestResult.parse({
      ok: true,
      tools: [
        { name: "read_file", description: "Read a file" },
        { name: "noop", description: null },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(ok.tools).toHaveLength(2);
    // null description 归一为空串。
    expect(ok.tools[1].description).toBe("");
  });

  it("parses a failed probe", () => {
    const fail = McpTestResult.parse({ ok: false, error: "connection refused", tools: [] });
    expect(fail.ok).toBe(false);
    expect(fail.error).toBe("connection refused");
  });
});

describe("McpEnabledResponse (PUT /api/mcp/servers/{name}/enabled)", () => {
  it("parses the toggle response", () => {
    expect(McpEnabledResponse.parse({ ok: true, name: "smoke-fs", enabled: true }).enabled).toBe(true);
  });
});

describe("McpCatalogResponse (GET /api/mcp/catalog)", () => {
  it("parses http-oauth and stdio-git entries plus diagnostics", () => {
    const payload = {
      entries: [
        {
          name: "linear",
          description: "Linear issue tracker",
          source: "https://linear.app",
          transport: "http",
          auth_type: "oauth",
          required_env: [],
          command: null,
          args: [],
          url: "https://mcp.linear.app/mcp",
          install_url: null,
          install_ref: null,
          bootstrap: [],
          default_enabled: null,
          post_install: "",
          needs_install: false,
          installed: false,
          enabled: false,
        },
        {
          name: "n8n",
          description: "n8n workflow automation",
          source: "github.com/n8n",
          transport: "stdio",
          auth_type: "api_key",
          required_env: [{ name: "N8N_API_KEY", prompt: "n8n API key", required: true }],
          command: "node",
          args: ["dist/index.js"],
          url: null,
          install_url: "https://github.com/example/n8n-mcp",
          install_ref: "v1.2.3",
          bootstrap: ["npm install", "npm run build"],
          default_enabled: ["list_workflows"],
          post_install: "Set up your n8n instance first.",
          needs_install: true,
          installed: true,
          enabled: true,
        },
      ],
      diagnostics: [{ name: "n8n", kind: "warning", message: "requires Node 20+" }],
    };
    const parsed = McpCatalogResponse.parse(payload);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[1].required_env[0].name).toBe("N8N_API_KEY");
    expect(parsed.entries[1].bootstrap).toHaveLength(2);
    expect(parsed.diagnostics[0].message).toContain("Node 20");
  });

  it("defaults diagnostics to [] when omitted", () => {
    expect(McpCatalogResponse.parse({ entries: [] }).diagnostics).toEqual([]);
  });
});

describe("McpCatalogInstallResponse (POST /api/mcp/catalog/install)", () => {
  it("parses sync and background installs", () => {
    expect(McpCatalogInstallResponse.parse({ ok: true, name: "linear", background: false }).background).toBe(false);
    const bg = McpCatalogInstallResponse.parse({
      ok: true,
      name: "n8n",
      background: true,
      action: "mcp-install",
    });
    expect(bg.action).toBe("mcp-install");
  });
});

describe("McpServerCreate (request body)", () => {
  it("accepts stdio with env + auth and http url", () => {
    expect(() =>
      McpServerCreate.parse({
        name: "fs",
        command: "npx",
        args: ["-y", "server"],
        env: { API_KEY: "secret" },
        auth: "oauth",
      }),
    ).not.toThrow();
    expect(() => McpServerCreate.parse({ name: "remote", url: "https://x/mcp" })).not.toThrow();
  });
});
