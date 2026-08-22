/**
 * `getToolDefinitions` — parity with Python `model_tools.get_tool_definitions()`.
 *
 * Combines toolset resolution, capability-gate filtering, and an LRU-ish memo
 * keyed on (enabled toolsets, disabled toolsets, registry generation).
 */

import "./catalog.js";
import { registry } from "./registry.js";
import { resolveMultipleToolsets } from "./toolsets.js";
import type { ToolConfigLike, ToolContext, ToolDefinition } from "./types.js";

interface MemoKey {
  enabled: string;
  disabled: string;
  generation: number;
  quiet: boolean;
  gui: boolean;
  kanban: boolean;
}

interface MemoEntry {
  key: MemoKey;
  result: ToolDefinition[];
  usedAt: number;
}

const memo: MemoEntry[] = [];
const MEMO_LIMIT = 8;

function makeKey(
  enabled: string[],
  disabled: string[],
  generation: number,
  quiet: boolean,
  ctx?: ToolContext,
): MemoKey {
  return {
    enabled: enabled.slice().sort().join(","),
    disabled: disabled.slice().sort().join(","),
    generation,
    quiet,
    gui: ctx?.isGuiSession ?? false,
    kanban: ctx?.kanbanWorker ?? false,
  };
}

function keysEqual(a: MemoKey, b: MemoKey): boolean {
  return (
    a.enabled === b.enabled &&
    a.disabled === b.disabled &&
    a.generation === b.generation &&
    a.quiet === b.quiet &&
    a.gui === b.gui &&
    a.kanban === b.kanban
  );
}

export interface GetToolDefinitionsOptions {
  quiet?: boolean;
  ctx?: ToolContext;
  customToolsets?: ToolConfigLike["custom_toolsets"];
  registryToolsets?: Set<string>;
}

/** Resolve enabled/disabled toolsets into OpenAI-format tool definitions. */
export async function getToolDefinitions(
  enabledToolsets: string[],
  disabledToolsets: string[],
  opts?: GetToolDefinitionsOptions,
): Promise<ToolDefinition[]> {
  const generation = registry.getGeneration();
  const key = makeKey(enabledToolsets, disabledToolsets, generation, opts?.quiet ?? false, opts?.ctx);

  const existing = memo.find((e) => keysEqual(e.key, key));
  if (existing) {
    existing.usedAt = Date.now();
    return existing.result;
  }

  const toolNames = resolveMultipleToolsets(enabledToolsets, {
    customToolsets: opts?.customToolsets,
    disabledToolsets,
    isGuiSession: opts?.ctx?.isGuiSession,
    kanbanWorker: opts?.ctx?.kanbanWorker,
    registryToolsets: opts?.registryToolsets,
  });

  const defs = await registry.getDefinitions(toolNames, opts?.ctx);
  const result = opts?.quiet
    ? defs.map((d) => ({
        ...d,
        function: { ...d.function, description: `${d.function.name} tool` },
      }))
    : defs;

  memo.push({ key, result, usedAt: Date.now() });
  if (memo.length > MEMO_LIMIT) {
    memo.sort((a, b) => a.usedAt - b.usedAt);
    memo.splice(0, memo.length - MEMO_LIMIT);
  }
  return result;
}

/** Exposed for tests. */
export function clearToolDefinitionsMemo(): void {
  memo.length = 0;
}

/** Peek memo state for tests. */
export function toolDefinitionsMemoSize(): number {
  return memo.length;
}
