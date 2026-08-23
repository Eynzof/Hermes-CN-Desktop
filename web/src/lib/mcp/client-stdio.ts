import type { McpTransport, StdioTransportDeps } from "./types.js";

export interface McpStdioClientTransportOptions {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  deps: StdioTransportDeps;
}

export class McpStdioClientTransport implements McpTransport {
  private childId?: string;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(private opts: McpStdioClientTransportOptions) {}

  async start(): Promise<void> {
    this.childId = await this.opts.deps.invoke<string>("mcp_stdio_spawn", {
      name: this.opts.name,
      command: this.opts.command,
      args: this.opts.args,
      env: this.opts.env,
      cwd: this.opts.cwd,
    });
    this.opts.deps.listen(`mcp_stdio_data:${this.childId}`, (payload) => {
      if (this.onmessage && payload && typeof payload === "object") {
        const bytes = (payload as { bytes?: number[] }).bytes;
        if (bytes && Array.isArray(bytes) && bytes.length > 0) {
          const text = new TextDecoder().decode(Uint8Array.from(bytes));
          try {
            this.onmessage(JSON.parse(text));
          } catch {
            this.onmessage(text);
          }
        }
      }
    });
    this.opts.deps.listen(`mcp_stdio_exit:${this.childId}`, () => {
      if (this.onclose) this.onclose();
    });
  }

  async send(message: unknown): Promise<void> {
    if (!this.childId) throw new Error("MCP stdio transport not started");
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(message) + "\n"));
    await this.opts.deps.invoke("mcp_stdio_write", { childId: this.childId, bytes });
  }

  async close(): Promise<void> {
    if (this.childId) {
      await this.opts.deps.invoke("mcp_stdio_kill", { childId: this.childId, graceMs: 5000 });
    }
  }
}
