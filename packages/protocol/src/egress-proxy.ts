import { z } from "zod";

export const EgressProxyRuleSchema = z.object({
  id: z.string(),
  pattern: z.string(),
  action: z.enum(["allow", "deny", "rewrite"]),
  target: z.string().optional(),
});
export type EgressProxyRule = z.infer<typeof EgressProxyRuleSchema>;

export const EgressProxyStatusSchema = z.object({
  running: z.boolean(),
  port: z.number().optional(),
  rules: z.array(EgressProxyRuleSchema).default([]),
});
export type EgressProxyStatus = z.infer<typeof EgressProxyStatusSchema>;

export const SecretImportSchema = z.object({
  key: z.string(),
  value: z.string(),
  source: z.enum(["env", "file", "vault"]).default("env"),
});
export type SecretImport = z.infer<typeof SecretImportSchema>;

export const SecretBundleSchema = z.object({
  secrets: z.record(z.string()).default({}),
  importedAt: z.string().datetime().optional(),
});
export type SecretBundle = z.infer<typeof SecretBundleSchema>;
