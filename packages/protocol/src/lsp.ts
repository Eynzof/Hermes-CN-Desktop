import { z } from "zod";

export const LspPositionSchema = z.object({
  line: z.number(),
  character: z.number(),
});

export const LspRangeSchema = z.object({
  start: LspPositionSchema,
  end: LspPositionSchema,
});

export const LspDiagnosticSchema = z.object({
  severity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  code: z.union([z.string(), z.number()]).optional(),
  source: z.string().optional(),
  message: z.string(),
  range: LspRangeSchema,
});
export type LspDiagnostic = z.infer<typeof LspDiagnosticSchema>;

export const LspConfigSchema = z.object({
  enabled: z.boolean().default(true),
  waitMode: z.enum(["document", "full"]).default("document"),
  waitTimeout: z.number().default(5),
  installStrategy: z.enum(["auto", "manual", "off"]).default("manual"),
  idleTimeout: z.number().default(600),
  servers: z.record(
    z.object({
      disabled: z.boolean().optional(),
      command: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      initializationOptions: z.unknown().optional(),
    })
  ).default({}),
});
export type LspConfig = z.infer<typeof LspConfigSchema>;

export const LspServerStatusSchema = z.object({
  serverId: z.string(),
  binary: z.string().optional(),
  installed: z.boolean(),
});
export type LspServerStatus = z.infer<typeof LspServerStatusSchema>;
