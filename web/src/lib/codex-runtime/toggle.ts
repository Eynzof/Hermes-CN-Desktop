import { CodexRuntimeSchema, type CodexRuntime, type CodexRuntimeStatus } from "@hermes/protocol/codex-runtime";

export function parseCodexRuntime(value: unknown): CodexRuntime {
  return CodexRuntimeSchema.parse(value);
}

export function getDefaultRuntime(): CodexRuntime {
  return "auto";
}

export function buildCodexRuntimeStatus(runtime: CodexRuntime, binaryOk: boolean): CodexRuntimeStatus {
  return { runtime, binaryOk };
}
