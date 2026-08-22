import type { ProcessTransport } from "./types.js";

export class MockProcessTransport implements ProcessTransport {
  private incoming: Uint8Array<ArrayBufferLike>[] = [];
  private closed = false;

  push(bytes: Uint8Array<ArrayBufferLike>): void {
    this.incoming.push(bytes);
  }

  async start(): Promise<void> {
    this.closed = false;
  }

  async write(_bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("transport closed");
  }

  async read(): Promise<Uint8Array<ArrayBufferLike> | null> {
    if (this.closed) return null;
    return this.incoming.shift() ?? null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
