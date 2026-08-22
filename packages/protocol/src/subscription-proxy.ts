import { z } from "zod";

export const ProxyProviderSchema = z.enum(["nous", "xai"]);
export type ProxyProvider = z.infer<typeof ProxyProviderSchema>;

export const ProxyStatusSchema = z.object({
  running: z.boolean(),
  port: z.number(),
  provider: ProxyProviderSchema,
  authenticated: z.boolean(),
});
export type ProxyStatus = z.infer<typeof ProxyStatusSchema>;

export const UpstreamCredentialSchema = z.object({
  bearer: z.string(),
  baseUrl: z.string(),
  tokenType: z.string(),
  expiresAt: z.string().optional(),
});
export type UpstreamCredential = z.infer<typeof UpstreamCredentialSchema>;
