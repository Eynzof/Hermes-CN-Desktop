import { z } from "zod";
import { register } from "../registry.js";
import { objectSchema } from "../catalog.js";

const echoHandler = async (args: unknown) => ({ content: JSON.stringify(args ?? {}, null, 2) });

register({
  name: "mcp_server_add",
  toolset: "mcp",
  description: "Add or update an MCP server configuration.",
  emoji: "🔌",
  schema: objectSchema({
    name: z.string().describe("Server short name"),
    transport: z.enum(["stdio", "sse", "http"]).describe("Transport type"),
    command: z.string().optional().describe("Command for stdio transport"),
    args: z.array(z.string()).optional().describe("Command arguments"),
    url: z.string().optional().describe("URL for HTTP/SSE transport"),
    enabled: z.boolean().optional().describe("Whether the server is enabled"),
  }),
  handler: echoHandler,
});

register({
  name: "mcp_server_remove",
  toolset: "mcp",
  description: "Remove an MCP server configuration.",
  emoji: "🔌",
  schema: objectSchema({ name: z.string() }),
  handler: echoHandler,
});

register({
  name: "mcp_server_list",
  toolset: "mcp",
  description: "List configured MCP servers and their statuses.",
  emoji: "🔌",
  schema: objectSchema({}),
  handler: echoHandler,
});

register({
  name: "mcp_server_test",
  toolset: "mcp",
  description: "Probe an MCP server and return its tool list.",
  emoji: "🔌",
  schema: objectSchema({ name: z.string() }),
  handler: echoHandler,
});
