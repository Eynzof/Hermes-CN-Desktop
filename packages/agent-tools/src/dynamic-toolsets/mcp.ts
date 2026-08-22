import type { ToolDefinition } from "../types.js";
import type { McpServerEntry } from "./types.js";

export interface McpConnectionManager {
  servers: McpServerEntry[];
  connect(name: string): Promise<McpServerEntry>;
  disconnect(name: string): Promise<void>;
  listTools(name: string): Promise<ToolDefinition[]>;
}

export class StubMcpConnectionManager implements McpConnectionManager {
  servers: McpServerEntry[] = [];
  async connect(name: string): Promise<McpServerEntry> {
    const server: McpServerEntry = {
      name,
      transport: "stdio",
      enabled: true,
      status: "connected",
      tools: [],
    };
    this.servers.push(server);
    return server;
  }
  async disconnect(name: string): Promise<void> {
    this.servers = this.servers.filter((s) => s.name !== name);
  }
  async listTools(_name: string): Promise<ToolDefinition[]> {
    return [];
  }
}

export function sanitizeMcpToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 64);
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${sanitizeMcpToolName(tool)}`;
}
