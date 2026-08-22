import { z } from "zod";
import { register } from "../registry.js";
import { objectSchema } from "../catalog.js";

register({
  name: "document_extract",
  toolset: "document_extract",
  description: "Extract plain text from structured documents (.ipynb, .docx, .xlsx, PDF, etc).",
  emoji: "📄",
  schema: objectSchema({
    path: z.string().describe("Document path"),
    maxBytes: z.number().optional().describe("Maximum bytes to read"),
  }),
  handler: async (args) => ({ content: `Would extract text from ${(args as any).path}` }),
});
