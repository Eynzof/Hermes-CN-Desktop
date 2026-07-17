import type { ConnectionMode } from "@hermes/protocol";

export type ProductMode = "managed" | "external";

export function productModeForConnection(mode: ConnectionMode): ProductMode {
  return mode === "managed" ? "managed" : "external";
}

export function canCompleteGuide(input: {
  backendReady: boolean;
  dashboardHttpOk: boolean;
  gatewayWsOk: boolean;
  hasCurrentModel: boolean;
}): boolean {
  return input.backendReady
    && input.dashboardHttpOk
    && input.gatewayWsOk
    && input.hasCurrentModel;
}
