import { z } from "zod";
import { register } from "../registry.js";
import { objectSchema } from "../catalog.js";

register({
  name: "egress_proxy_start",
  toolset: "egress_proxy",
  description: "Start the local egress proxy.",
  emoji: "🌐",
  schema: objectSchema({ port: z.number().optional() }),
  handler: async (args) => ({ content: `Would start egress proxy on port ${(args as any).port ?? 8650}` }),
});

register({
  name: "egress_proxy_import_secrets",
  toolset: "egress_proxy",
  description: "Import secrets into the egress proxy vault.",
  emoji: "🔐",
  schema: objectSchema({ secretsJson: z.string() }),
  handler: async (args) => ({ content: "Would import secrets" }),
});

register({
  name: "egress_proxy_status",
  toolset: "egress_proxy",
  description: "Check egress proxy status.",
  emoji: "🌐",
  schema: objectSchema({}),
  handler: async () => ({ content: "Would report egress proxy status" }),
});
