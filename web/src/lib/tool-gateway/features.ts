import type { ToolFeatureState, ToolGatewayConfig } from "./types.js";

export const TOOL_FEATURES: ToolFeatureState[] = [
  { key: "web", label: "Web search", available: true, active: false, managedByNous: false },
  { key: "image_gen", label: "Image generation", available: true, active: false, managedByNous: false },
  { key: "tts", label: "Text to speech", available: true, active: false, managedByNous: false },
  { key: "browser", label: "Browser automation", available: true, active: false, managedByNous: false },
];

export function getNousSubscriptionFeatures(config: ToolGatewayConfig): ToolFeatureState[] {
  return TOOL_FEATURES.map((f) => {
    const useGateway = config[f.key]?.useGateway ?? false;
    return { ...f, active: useGateway, managedByNous: useGateway };
  });
}

export function setUseGateway(config: ToolGatewayConfig, key: string, enabled: boolean): ToolGatewayConfig {
  return { ...config, [key]: { ...(config[key] ?? {}), useGateway: enabled } };
}
