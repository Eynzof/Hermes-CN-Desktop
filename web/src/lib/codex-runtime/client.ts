import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CodexItemEvent, CodexTurnResult, CodexPluginInfo, CodexModelInfo, CodexRuntimeStatus } from "./types.js";

export interface CodexClientDeps {
  invoke: typeof invoke;
  listen: typeof listen;
}

export class CodexClient {
  constructor(private deps: CodexClientDeps) {}

  async checkBinary(): Promise<boolean> {
    return this.deps.invoke<boolean>("codex_app_server_check");
  }

  async start(cwd?: string, codexHome?: string): Promise<void> {
    return this.deps.invoke("codex_app_server_start", { cwd, codexHome });
  }

  async runTurn(input: string, requestId: string): Promise<CodexTurnResult> {
    return this.deps.invoke<CodexTurnResult>("codex_app_server_run_turn", { input, requestId });
  }

  async interrupt(): Promise<void> {
    return this.deps.invoke("codex_app_server_interrupt");
  }

  async close(): Promise<void> {
    return this.deps.invoke("codex_app_server_close");
  }

  async respondApproval(requestId: string, result: unknown): Promise<void> {
    return this.deps.invoke("codex_app_server_respond", { requestId, result: JSON.stringify(result) });
  }

  async listPlugins(): Promise<CodexPluginInfo[]> {
    return this.deps.invoke<CodexPluginInfo[]>("codex_app_server_plugin_list");
  }

  async applyConfigToml(patch: string): Promise<void> {
    return this.deps.invoke("codex_app_server_apply_config_toml", { patch });
  }

  async status(): Promise<CodexRuntimeStatus> {
    return this.deps.invoke<CodexRuntimeStatus>("codex_app_server_status");
  }

  subscribeEvents(cb: (event: CodexItemEvent) => void): () => void {
    let unsub: (() => void) | undefined;
    this.deps.listen("codex-app-server-event", (e) => {
      cb(e.payload as CodexItemEvent);
    }).then((u) => { unsub = u; });
    return () => unsub?.();
  }
}
