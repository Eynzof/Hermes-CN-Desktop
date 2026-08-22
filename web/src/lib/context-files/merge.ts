// Re-export the canonical merge implementation from agent-core so the web and
// runtime use the same prompt-building logic.
export { mergeContextFiles, type ContextMergeResult } from "@hermes/agent-core";
