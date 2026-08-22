import { z } from "zod";
import { register } from "../registry.js";
import { objectSchema } from "../catalog.js";

register({
  name: "tool_gateway_status",
  toolset: "tool_gateway",
  description: "Return Nous Tool Gateway portal status and per-tool routing.",
  emoji: "🌀",
  schema: objectSchema({}),
  handler: async () => ({ content: "Would return tool gateway status" }),
});

register({
  name: "tool_gateway_call",
  toolset: "tool_gateway",
  description: "Call a managed tool through the Nous Tool Gateway.",
  emoji: "🌀",
  schema: objectSchema({
    vendor: z.enum(["firecrawl", "fal-queue", "openai-audio", "browser-use"]),
    path: z.string(),
    method: z.enum(["GET", "POST"]),
    body: z.string().optional(),
  }),
  handler: async () => ({ content: "Would call managed tool gateway" }),
});
