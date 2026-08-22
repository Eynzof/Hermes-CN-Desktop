import { invoke } from "@tauri-apps/api/core";
import type { EgressProxyStatus, SecretBundle } from "./types.js";

export interface EgressProxyClientDeps {
  invoke: typeof invoke;
}

export class EgressProxyClient {
  constructor(private deps: EgressProxyClientDeps) {}

  async start(port?: number): Promise<EgressProxyStatus> {
    return this.deps.invoke<EgressProxyStatus>("egress_proxy_start", { port });
  }

  async stop(): Promise<void> {
    return this.deps.invoke("egress_proxy_stop");
  }

  async status(): Promise<EgressProxyStatus> {
    return this.deps.invoke<EgressProxyStatus>("egress_proxy_status");
  }

  async setRules(rules: unknown[]): Promise<EgressProxyStatus> {
    return this.deps.invoke<EgressProxyStatus>("egress_proxy_set_rules", { rulesJson: JSON.stringify(rules) });
  }

  async downloadRulePack(url: string): Promise<string> {
    return this.deps.invoke<string>("egress_proxy_download", { url });
  }

  async importSecrets(secrets: Record<string, string>): Promise<SecretBundle> {
    return this.deps.invoke<SecretBundle>("egress_proxy_import_secrets", { secretsJson: JSON.stringify(secrets) });
  }

  async exportSecrets(): Promise<SecretBundle> {
    return this.deps.invoke<SecretBundle>("egress_proxy_export_secrets");
  }
}
