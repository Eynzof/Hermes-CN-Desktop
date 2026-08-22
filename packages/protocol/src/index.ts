export * from "./hermes-api";
export * from "./projects";
export * from "./channels";
export * from "./session-log";
export * from "./session-search";
export * from "./spotify";
export * from "./meet-api";
export * from "./observability";
export * from "./wake";
export {
  platformConfigSchema,
  messagingGatewayStatusSchema,
  messagingPlatformListSchema,
  messagingPlatforms,
  type PlatformConfig,
  type MessagingGatewayStatus,
  type MessagingPlatformList,
} from "./messaging";

export type WindowType = "electron" | "tauri" | "web";
export type BuildFlavor = "dev" | "prod";
export type ThemeVariant = "light" | "dark";
export type AccentVariant = "amber" | "ink" | "tea";
export type DensityVariant = "comfortable" | "compact";
