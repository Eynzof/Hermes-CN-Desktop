import { z } from "zod";

export const ToolGatewayVendorSchema = z.enum(["firecrawl", "fal-queue", "openai-audio", "browser-use"]);
export type ToolGatewayVendor = z.infer<typeof ToolGatewayVendorSchema>;

export const NousTokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
});
export type NousToken = z.infer<typeof NousTokenSchema>;

export const ToolFeatureStateSchema = z.object({
  key: z.string(),
  label: z.string(),
  available: z.boolean(),
  active: z.boolean(),
  managedByNous: z.boolean(),
  directOverride: z.boolean().optional(),
  currentProvider: z.string().optional(),
});
export type ToolFeatureState = z.infer<typeof ToolFeatureStateSchema>;

export const PortalStatusResponseSchema = z.object({
  loggedIn: z.boolean(),
  portalUrl: z.string(),
  inferenceUrl: z.string(),
  provider: z.string(),
  subscriptionUrl: z.string(),
  features: z.array(ToolFeatureStateSchema),
});
export type PortalStatusResponse = z.infer<typeof PortalStatusResponseSchema>;

export const ToolGatewayConfigSchema = z.record(z.object({ useGateway: z.boolean().optional() }));
export type ToolGatewayConfig = z.infer<typeof ToolGatewayConfigSchema>;
