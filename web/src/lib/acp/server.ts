import type { AcpServerRequest, AcpServerResponse } from "./types.js";

export function buildAcpInitializeResponse(
  request: AcpServerRequest,
): AcpServerResponse {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: {
      protocolVersion: "0.9.0",
      capabilities: { tools: {}, prompts: {}, resources: {} },
      serverInfo: { name: "hermes-acp", version: "0.1.0" },
    },
  };
}

export function buildAcpError(
  id: string | number | undefined,
  code: number,
  message: string,
): AcpServerResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
