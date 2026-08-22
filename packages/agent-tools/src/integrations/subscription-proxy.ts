import { z } from "zod";
import { register } from "../registry.js";
import { objectSchema } from "../catalog.js";

register({
  name: "subscription_proxy_status",
  toolset: "subscription_proxy",
  description: "Show the subscription proxy status and listening port.",
  emoji: "🌐",
  schema: objectSchema({}),
  handler: async () => ({ content: "Would report subscription proxy status" }),
});

register({
  name: "subscription_proxy_start",
  toolset: "subscription_proxy",
  description: "Start the subscription proxy.",
  emoji: "🌐",
  schema: objectSchema({ provider: z.enum(["nous", "xai"]) }),
  handler: async (args) => ({ content: `Would start subscription proxy for ${(args as any).provider}` }),
});
