import { z } from "zod";

export const CodexRuntimeSchema = z.enum(["auto", "codex_app_server"]);
export type CodexRuntime = z.infer<typeof CodexRuntimeSchema>;

export const CodexTurnResultSchema = z.object({
  finalText: z.string().optional(),
  projectedMessages: z.array(z.unknown()).default([]),
  toolIterations: z.number().default(0),
  interrupted: z.boolean().default(false),
  error: z.string().optional(),
  turnId: z.string().optional(),
  threadId: z.string().optional(),
  tokenUsageLast: z.number().optional(),
  tokenUsageTotal: z.number().optional(),
});
export type CodexTurnResult = z.infer<typeof CodexTurnResultSchema>;

export const CodexItemEventSchema = z.object({
  type: z.string(),
  item: z.record(z.unknown()).optional(),
  delta: z.unknown().optional(),
});
export type CodexItemEvent = z.infer<typeof CodexItemEventSchema>;

export const CodexPluginInfoSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
});
export type CodexPluginInfo = z.infer<typeof CodexPluginInfoSchema>;

export const CodexModelInfoSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
});
export type CodexModelInfo = z.infer<typeof CodexModelInfoSchema>;

export const CodexRuntimeStatusSchema = z.object({
  runtime: CodexRuntimeSchema,
  binaryOk: z.boolean(),
});
export type CodexRuntimeStatus = z.infer<typeof CodexRuntimeStatusSchema>;
