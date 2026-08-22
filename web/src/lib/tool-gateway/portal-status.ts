import { getNousPortalAccountInfo } from "./entitlement.js";
import { getNousSubscriptionFeatures } from "./features.js";
import type { ToolGatewayConfig } from "./types.js";

export function getPortalStatus(config: ToolGatewayConfig) {
  const account = getNousPortalAccountInfo();
  const features = getNousSubscriptionFeatures(config);
  return { ...account, features };
}
