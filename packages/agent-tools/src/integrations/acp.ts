import { z } from "zod";
import { register } from "../registry.js";
import { objectSchema } from "../catalog.js";

const echo = async (args: unknown) => ({ content: JSON.stringify(args) });

register({
  name: "acp_ide_start",
  toolset: "acp_ide",
  description: "Start the ACP IDE server.",
  emoji: "🖥️",
  schema: objectSchema({ cwd: z.string().optional() }),
  handler: echo,
});

register({
  name: "acp_ide_status",
  toolset: "acp_ide",
  description: "Get ACP IDE server status.",
  emoji: "🖥️",
  schema: objectSchema({}),
  handler: echo,
});

register({
  name: "acp_ide_list_sessions",
  toolset: "acp_ide",
  description: "List active ACP IDE sessions.",
  emoji: "🖥️",
  schema: objectSchema({}),
  handler: echo,
});
