import { z } from "zod";
import type { ContextFile, ContextFileSource, ProviderApiMode, ProfileSnapshot } from "../types.js";

export const ProviderApiModeSchema = z.enum([
  "chat_completions",
  "codex_responses",
  "anthropic_messages",
  "bedrock_converse",
  "codex_app_server",
]) as z.ZodType<ProviderApiMode>;

export const ContextFileSourceSchema = z.enum([
  "hermes",
  "agents",
  "claude",
  "cursor",
  "soul",
]) as z.ZodType<ContextFileSource>;

export const ContextFileSchema = z.object({
  path: z.string(),
  source: ContextFileSourceSchema,
  content: z.string(),
  provenance: z.string().optional(),
}) as z.ZodType<ContextFile>;

  export const ReasoningConfigSchema = z.object({
    effort: z.enum(["low", "medium", "high"]).optional(),
    budgetTokens: z.number().int().nonnegative().optional(),
    disabled: z.boolean().optional(),
    enabled: z.boolean().optional(),
  });

export const PlatformIdentitySchema = z.object({
  platform: z.string().optional(),
  userId: z.string().optional(),
  chatId: z.string().optional(),
  gatewaySessionKey: z.string().optional(),
});

export const ProfileSnapshotSchema = z.object({
  model: z.string(),
  provider: z.string(),
  apiMode: ProviderApiModeSchema,
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  enabledToolsets: z.array(z.string()).optional(),
  disabledToolsets: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  memoryProvider: z.string().optional(),
  reasoningConfig: ReasoningConfigSchema.optional(),
  platformIdentity: PlatformIdentitySchema.optional(),
  contextFiles: z.array(ContextFileSchema).optional(),
}).passthrough() as z.ZodType<ProfileSnapshot>;
