import { invoke } from "@tauri-apps/api/core";
import type { TelemetryConfig } from "./types.js";

export interface ObservabilityClientDeps {
  invoke: typeof invoke;
}

export class ObservabilityClient {
  constructor(private deps: ObservabilityClientDeps) {}

  async getConfig(): Promise<TelemetryConfig> {
    return this.deps.invoke<TelemetryConfig>("observability_get_config");
  }

  async setConfig(config: TelemetryConfig): Promise<void> {
    return this.deps.invoke("observability_set_config", { configJson: JSON.stringify(config) });
  }
}
