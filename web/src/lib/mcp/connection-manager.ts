import type { McpServerConfig, McpServerEntry, McpServerStatus, McpTestResult, McpToolCallRequest, McpTransport } from "./types.js";

export type McpStatusCallback = (entries: McpServerEntry[]) => void;

export interface McpConnectionManagerDeps {
  createTransport(name: string, config: McpServerConfig): McpTransport;
}

export class McpConnectionManager {
  private entries = new Map<string, McpServerEntry>();
  private transports = new Map<string, McpTransport>();
  private statusCbs: McpStatusCallback[] = [];

  constructor(private deps: McpConnectionManagerDeps) {}

  snapshot(): McpServerEntry[] {
    return Array.from(this.entries.values());
  }

  onStatusChange(cb: McpStatusCallback): () => void {
    this.statusCbs.push(cb);
    return () => {
      const i = this.statusCbs.indexOf(cb);
      if (i >= 0) this.statusCbs.splice(i, 1);
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const cb of this.statusCbs) cb(snap);
  }

  upsert(config: McpServerConfig): void {
    const entry: McpServerEntry = {
      name: config.name,
      config,
      status: config.enabled === false ? "disabled" : "pending",
      toolCount: 0,
      error: null,
    };
    this.entries.set(config.name, entry);
    this.emit();
  }

  remove(name: string): void {
    this.entries.delete(name);
    this.transports.get(name)?.close().catch(() => {});
    this.transports.delete(name);
    this.emit();
  }

  async connectAllNow(configs: McpServerConfig[]): Promise<void> {
    for (const c of configs) this.upsert(c);
    await Promise.all(configs.map((c) => this.connect(c.name)));
  }

  async connect(name: string): Promise<McpTestResult> {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, message: "MCP server not registered" };
    this.setStatus(name, "connecting");
    try {
      const transport = this.deps.createTransport(name, entry.config);
      this.transports.set(name, transport);
      transport.onmessage = (msg) => this.handleMessage(name, msg);
      transport.onclose = () => this.setStatus(name, "failed");
      transport.onerror = (err) => this.setError(name, err.message);
      await transport.start();
      await transport.send({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "hermes-desktop", version: "0.1.0" },
        },
      });
      this.setStatus(name, "connected");
      return { ok: true, message: "connected" };
    } catch (err: any) {
      this.setStatus(name, "failed");
      this.setError(name, String(err?.message ?? err));
      return { ok: false, message: String(err?.message ?? err) };
    }
  }

  async callTool(req: McpToolCallRequest): Promise<unknown> {
    const transport = this.transports.get(req.server);
    if (!transport) throw new Error(`MCP server ${req.server} not connected`);
    await transport.send({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: req.tool, arguments: req.arguments },
    });
    return { ack: true };
  }

  private setStatus(name: string, status: McpServerStatus): void {
    const entry = this.entries.get(name);
    if (entry) {
      entry.status = status;
      this.emit();
    }
  }

  private setError(name: string, message: string): void {
    const entry = this.entries.get(name);
    if (entry) {
      entry.error = message;
      this.emit();
    }
  }

  private handleMessage(name: string, msg: unknown): void {
    if (msg && typeof msg === "object" && "result" in msg) {
      const result = (msg as { result?: unknown }).result;
      if (result && typeof result === "object" && "tools" in result) {
        const tools = (result as { tools?: unknown[] }).tools;
        const entry = this.entries.get(name);
        if (entry && Array.isArray(tools)) {
          entry.toolCount = tools.length;
          this.emit();
        }
      }
    }
  }
}
