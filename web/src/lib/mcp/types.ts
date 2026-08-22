import type * as proto from "@hermes/protocol/mcp";

export type McpServerConfig = proto.McpServerConfig;
export type McpServerEntry = proto.McpServerEntry;
export type McpServerStatus = proto.McpServerStatus;
export type McpTestResult = proto.McpTestResult;
export type McpCatalogEntry = proto.McpCatalogEntry;
export type McpToolCallRequest = proto.McpToolCallRequest;

export interface McpTransport {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

export interface StdioTransportDeps {
  invoke: <T>(cmd: string, args?: unknown) => Promise<T>;
  listen: (event: string, cb: (payload: unknown) => void) => void;
}
