import { encodeJsonRpc, decodeJsonRpcFrames } from "./protocol.js";
import type { ProcessTransport, LspDiagnostic } from "./types.js";

export interface LspClientDeps {
  transport: ProcessTransport;
}

export class LspClient {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private pending = new Map<string | number, (msg: unknown) => void>();
  private diagnostics = new Map<string, LspDiagnostic[]>();

  constructor(private deps: LspClientDeps) {}

  async initialize(rootUri: string): Promise<unknown> {
    await this.deps.transport.start();
    return this.request("initialize", {
      processId: null,
      rootUri,
      capabilities: {},
      workspaceFolders: null,
    });
  }

  async openFile(uri: string, languageId: string, version: number, text: string): Promise<void> {
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  async saveFile(uri: string, version: number, text: string): Promise<void> {
    await this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    await this.notify("textDocument/didSave", { textDocument: { uri } });
  }

  async shutdown(): Promise<void> {
    await this.request("shutdown", {});
    await this.notify("exit", {});
    await this.deps.transport.close();
  }

  getDiagnostics(uri: string): LspDiagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  async pump(): Promise<void> {
    const chunk = await this.deps.transport.read();
    if (!chunk) return;
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer as Uint8Array);
    combined.set(chunk, this.buffer.length);
    const { messages, remainder } = decodeJsonRpcFrames(combined);
    this.buffer = remainder as Uint8Array<ArrayBufferLike>;
    for (const msg of messages) {
      this.handleMessage(msg);
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = Math.random().toString(36).slice(2);
    const message = { jsonrpc: "2.0", id, method, params };
    await this.deps.transport.write(encodeJsonRpc(message));
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve(undefined);
        }
      }, 5000);
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const message = { jsonrpc: "2.0", method, params };
    await this.deps.transport.write(encodeJsonRpc(message));
  }

  private handleMessage(msg: unknown): void {
    if (msg && typeof msg === "object") {
      const m = msg as { id?: string | number; result?: unknown; method?: string; params?: unknown };
      if (m.id !== undefined && this.pending.has(m.id)) {
        const cb = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        cb(m.result);
      }
      if (m.method === "textDocument/publishDiagnostics") {
        const params = m.params as { uri: string; diagnostics: LspDiagnostic[] } | undefined;
        if (params) this.diagnostics.set(params.uri, params.diagnostics);
      }
    }
  }
}
