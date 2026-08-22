import { z } from "zod";

export const McpTransportType = z.enum(["stdio", "sse", "http"]);
export type McpTransportType = z.infer<typeof McpTransportType>;

export const McpServerConfigSchema = z.object({
  name: z.string(),
  transport: McpTransportType,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  tools: z.object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }).optional(),
  lazy: z.boolean().optional(),
  enabled: z.boolean().optional().default(true),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServerStatusSchema = z.enum([
  "pending",
  "connecting",
  "connected",
  "failed",
  "disabled",
  "needs-auth",
]);
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

export const McpServerEntrySchema = z.object({
  name: z.string(),
  config: McpServerConfigSchema,
  status: McpServerStatusSchema,
  toolCount: z.number().default(0),
  error: z.string().nullable().default(null),
});
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

export const McpTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  tools: z.array(z.string()).optional(),
});
export type McpTestResult = z.infer<typeof McpTestResultSchema>;

export const McpCatalogEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  publisher: z.string().optional(),
  installCommand: z.string().optional(),
});
export type McpCatalogEntry = z.infer<typeof McpCatalogEntrySchema>;

export const McpToolCallRequestSchema = z.object({
  server: z.string(),
  tool: z.string(),
  arguments: z.record(z.unknown()).optional(),
});
export type McpToolCallRequest = z.infer<typeof McpToolCallRequestSchema>;
