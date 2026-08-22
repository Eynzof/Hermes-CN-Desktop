export type {
  AcpSessionState,
  AcpSessionRow,
  ApprovalDecision,
  AcpInitializeParams,
  AcpStatus,
} from "@hermes/protocol/acp";

export interface AcpServerRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface AcpServerResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}
