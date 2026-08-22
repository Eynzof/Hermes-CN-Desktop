import { LspClient } from "./client.js";
import type { LspDiagnostic, ProcessTransport, ServerDef } from "./types.js";

export interface LspServiceDeps {
  createClient(serverId: string, root: string): Promise<{ client: LspClient; transport: ProcessTransport }>;
}

export class LspService {
  private clients = new Map<string, LspClient>();
  private baselines = new Map<string, LspDiagnostic[]>();
  private broken = new Set<string>();

  constructor(private deps: LspServiceDeps) {}

  key(serverId: string, root: string): string {
    return `${serverId}::${root}`;
  }

  async snapshotBaseline(path: string, serverId: string, root: string, text: string): Promise<void> {
    const client = await this.getOrSpawn(serverId, root);
    await client.openFile(path, "unknown", 1, text);
    await client.pump();
    this.baselines.set(path, client.getDiagnostics(path));
  }

  async getDiagnosticsSync(
    path: string,
    serverId: string,
    root: string,
    text: string,
  ): Promise<LspDiagnostic[]> {
    const client = await this.getOrSpawn(serverId, root);
    await client.saveFile(path, 2, text);
    await client.pump();
    const after = client.getDiagnostics(path);
    const baseline = this.baselines.get(path) ?? [];
    return after.filter((d) => !baseline.some((b) => sameDiagnostic(b, d)));
  }

  markBroken(serverId: string, root: string): void {
    this.broken.add(this.key(serverId, root));
  }

  private async getOrSpawn(serverId: string, root: string): Promise<LspClient> {
    const k = this.key(serverId, root);
    if (this.broken.has(k)) throw new Error(`LSP server ${serverId} is broken`);
    if (this.clients.has(k)) return this.clients.get(k)!;
    const { client } = await this.deps.createClient(serverId, root);
    await client.initialize(root);
    this.clients.set(k, client);
    return client;
  }
}

function sameDiagnostic(a: LspDiagnostic, b: LspDiagnostic): boolean {
  return (
    a.message === b.message &&
    a.range.start.line === b.range.start.line &&
    a.range.start.character === b.range.start.character
  );
}
