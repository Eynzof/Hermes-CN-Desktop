import { z } from "zod";
import { register } from "../registry.js";
import { objectSchema } from "../catalog.js";

register({
  name: "codex_runtime_toggle",
  toolset: "codex_runtime",
  description: "Toggle Codex app-server runtime mode.",
  emoji: "🤖",
  schema: objectSchema({ runtime: z.enum(["auto", "codex_app_server"]) }),
  handler: async (args) => ({ content: `Codex runtime set to ${(args as any).runtime}` }),
});

register({
  name: "codex_runtime_status",
  toolset: "codex_runtime",
  description: "Check Codex app-server runtime status.",
  emoji: "🤖",
  schema: objectSchema({}),
  handler: async () => ({ content: "Would report Codex runtime status" }),
});
