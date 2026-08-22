import { z } from "zod";

export const AcpSessionStateSchema = z.object({
  sessionId: z.string(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  mode: z.enum(["default", "accept_edits", "dont_ask"]).default("default"),
  history: z.array(z.unknown()).default([]),
  queuedPrompts: z.array(z.string()).default([]),
  isRunning: z.boolean().default(false),
  currentPromptText: z.string().optional(),
});
export type AcpSessionState = z.infer<typeof AcpSessionStateSchema>;

export const AcpSessionRowSchema = z.object({
  id: z.string(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  title: z.string().optional(),
  preview: z.string().optional(),
  messageCount: z.number().default(0),
  lastActive: z.number(),
  startedAt: z.number(),
  historyJson: z.string().optional(),
  parentSessionId: z.string().optional(),
  endReason: z.string().optional(),
});
export type AcpSessionRow = z.infer<typeof AcpSessionRowSchema>;

export const ApprovalDecisionSchema = z.enum(["once", "session", "always", "deny", "timeout", "cancelled"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const AcpInitializeParamsSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.record(z.unknown()).optional(),
  clientInfo: z.object({ name: z.string(), version: z.string() }),
});
export type AcpInitializeParams = z.infer<typeof AcpInitializeParamsSchema>;

export const AcpStatusSchema = z.object({
  running: z.boolean(),
  pid: z.number().optional(),
});
export type AcpStatus = z.infer<typeof AcpStatusSchema>;
