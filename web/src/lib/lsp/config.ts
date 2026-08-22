import { LspConfigSchema, type LspConfig } from "@hermes/protocol/lsp";

export function loadLspConfig(raw: unknown): LspConfig {
  return LspConfigSchema.parse(raw);
}
