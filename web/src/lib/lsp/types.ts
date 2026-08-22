export type { LspDiagnostic, LspConfig, LspServerStatus } from "@hermes/protocol/lsp";

export interface ProcessTransport {
  start(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  read(): Promise<Uint8Array<ArrayBufferLike> | null>;
  close(): Promise<void>;
}

export interface ServerDef {
  id: string;
  languages: string[];
  extensions: string[];
  command: string[];
  description: string;
}
