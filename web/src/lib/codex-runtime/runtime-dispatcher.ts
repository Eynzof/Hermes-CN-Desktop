import type { CodexRuntime } from "./types.js";

export function shouldUseCodexAppServer(runtime: CodexRuntime, provider: string): boolean {
  return runtime === "codex_app_server" && /openai|codex/i.test(provider);
}
