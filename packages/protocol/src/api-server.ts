import { z } from "zod";

export const ChatCompletionMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]).optional(),
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatCompletionMessageSchema),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export const ChatCompletionChoiceSchema = z.object({
  index: z.number().default(0),
  message: ChatCompletionMessageSchema,
  finish_reason: z.string().nullable().default("stop"),
});

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number(),
  model: z.string(),
  choices: z.array(ChatCompletionChoiceSchema),
});
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;

export const ChatCompletionChunkSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion.chunk"),
  created: z.number(),
  model: z.string(),
  choices: z.array(z.object({
    index: z.number(),
    delta: ChatCompletionMessageSchema.partial(),
    finish_reason: z.string().nullable().optional(),
  })),
});
export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunkSchema>;

export const ApiServerStatusSchema = z.object({
  running: z.boolean(),
  port: z.number(),
});
export type ApiServerStatus = z.infer<typeof ApiServerStatusSchema>;
