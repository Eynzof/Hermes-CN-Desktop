import type { CodexModelInfo } from "./types.js";

export const DEFAULT_CODEX_MODELS: CodexModelInfo[] = [
  { id: "o4-mini" },
  { id: "o3" },
];

export async function getCodexModelIds(fetchImpl = fetch): Promise<CodexModelInfo[]> {
  // v1 stub: return curated defaults.
  return DEFAULT_CODEX_MODELS;
}
