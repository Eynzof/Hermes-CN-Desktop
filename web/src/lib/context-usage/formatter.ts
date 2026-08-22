/**
 * Context-breakdown formatter for `/context` and the context-usage panel.
 *
 * Ported from Python `agent/context_breakdown.py` to run in the TypeScript
 * process. Token estimates use the same heuristic as the in-process agent core
 * (`estimateTokens` / `estimateMessagesTokens`) so the numbers stay consistent
 * with `/compress`.
 */

import {
  estimateMessagesTokens,
  estimateTokens,
  type Message,
  type ToolCall,
} from "@hermes/agent-core";
import type { SessionMessage } from "@hermes/protocol";

export interface ContextTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  /** Optional toolset name; if absent, the formatter infers one. */
  toolset?: string;
}

export interface ContextBreakdownCategory {
  id: string;
  label: string;
  tokens: number;
  color: string;
}

export interface ContextSkillDetail {
  name: string;
  indexTokens: number;
  skillMdTokens: number | null;
}

export interface ContextToolsetDetail {
  toolset: string;
  toolCount: number;
  schemaTokens: number;
}

export interface ContextDetails {
  skills: ContextSkillDetail[];
  toolsets: ContextToolsetDetail[];
}

export interface ContextBreakdownSnapshot {
  model?: string;
  contextMax?: number;
  systemPrompt?: string;
  rules?: string;
  skillsText?: string;
  memoryText?: string;
  conversationMessages?: readonly SessionMessage[];
  tools?: readonly ContextTool[];
  mcpTools?: readonly ContextTool[];
  subagentTools?: readonly ContextTool[];
}

export interface ContextBreakdown {
  model?: string;
  contextMax: number;
  contextUsed: number;
  contextPercent: number;
  estimatedTotal: number;
  categories: ContextBreakdownCategory[];
  details: ContextDetails;
}

interface CategoryDef {
  id: string;
  label: string;
  color: string;
  compute: (snapshot: ContextBreakdownSnapshot) => number;
}

const CATEGORIES: CategoryDef[] = [
  {
    id: "system_prompt",
    label: "System Prompt",
    color: "var(--context-usage-system)",
    compute: (s) => estimateTokens(s.systemPrompt ?? ""),
  },
  {
    id: "tool_definitions",
    label: "Tool Definitions",
    color: "var(--context-usage-tools)",
    compute: (s) => estimateToolSchemaTokens(s.tools ?? []),
  },
  {
    id: "rules",
    label: "Rules",
    color: "var(--context-usage-rules)",
    compute: (s) => estimateTokens(s.rules ?? ""),
  },
  {
    id: "skills",
    label: "Skills Index",
    color: "var(--context-usage-skills)",
    compute: (s) => estimateTokens(s.skillsText ?? ""),
  },
  {
    id: "mcp",
    label: "MCP Tools",
    color: "var(--context-usage-mcp)",
    compute: (s) => estimateToolSchemaTokens(s.mcpTools ?? []),
  },
  {
    id: "subagent_definitions",
    label: "Subagent Definitions",
    color: "var(--context-usage-subagent)",
    compute: (s) => estimateToolSchemaTokens(s.subagentTools ?? []),
  },
  {
    id: "memory",
    label: "Memory / Profile",
    color: "var(--context-usage-memory)",
    compute: (s) => estimateTokens(s.memoryText ?? ""),
  },
  {
    id: "conversation",
    label: "Conversation",
    color: "var(--context-usage-conversation)",
    compute: (s) => estimateConversationTokens(s.conversationMessages ?? []),
  },
];

const DEFAULT_CONTEXT_MAX = 128_000;

function estimateToolSchemaTokens(tools: readonly ContextTool[]): number {
  let tokens = 0;
  for (const tool of tools) {
    tokens += estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  }
  return tokens;
}

function estimateConversationTokens(messages: readonly SessionMessage[]): number {
  if (messages.length === 0) return 0;
  const coreMessages: Message[] = messages.map((m) => ({
    role: m.role as Message["role"],
    content: typeof m.content === "string" ? m.content : "",
    toolCalls: m.tool_calls ? (m.tool_calls as ToolCall[]) : undefined,
  }));
  return estimateMessagesTokens(coreMessages);
}

function inferToolset(tool: ContextTool): string {
  if (tool.toolset) return tool.toolset;
  const name = tool.name.toLowerCase();
  if (name.startsWith("mcp_")) return "mcp";
  if (name === "delegate_task" || name.startsWith("delegate")) return "subagent";
  if (name.includes("skill_") || name.startsWith("skill")) return "skills";
  return "builtin";
}

export function parseContextArgs(args: string): { all: boolean } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  return { all: tokens.some((t) => t.toLowerCase() === "all") };
}

export function computeContextBreakdown(snapshot: ContextBreakdownSnapshot): ContextBreakdown {
  const categories: ContextBreakdownCategory[] = CATEGORIES.map((def) => ({
    id: def.id,
    label: def.label,
    tokens: def.compute(snapshot),
    color: def.color,
  }));

  const estimatedTotal = categories.reduce((sum, c) => sum + c.tokens, 0);
  const contextMax = Math.max(0, snapshot.contextMax ?? DEFAULT_CONTEXT_MAX);
  // Prefer an explicit compressor value if provided; otherwise fall back to the
  // locally estimated total. This matches Python `context_used = last_prompt_tokens
  // if available else estimated_total`.
  const contextUsed = contextMax > 0 && snapshot.contextMax !== undefined && snapshot.contextMax === 0
    ? 0
    : estimatedTotal;
  const contextPercent = contextMax > 0 ? Math.min(100, Math.max(0, (contextUsed / contextMax) * 100)) : 0;

  const details = buildContextDetails(snapshot);

  return {
    model: snapshot.model,
    contextMax,
    contextUsed,
    contextPercent,
    estimatedTotal,
    categories,
    details,
  };
}

function buildContextDetails(snapshot: ContextBreakdownSnapshot): ContextDetails {
  const skills: ContextSkillDetail[] = [];
  const skillLines = (snapshot.skillsText ?? "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of skillLines) {
    const name = line.split(/\s+/)[0] ?? line;
    skills.push({
      name,
      indexTokens: estimateTokens(line),
      skillMdTokens: null,
    });
  }

  const groups = new Map<string, { toolCount: number; schemaTokens: number }>();
  for (const tool of [...(snapshot.tools ?? []), ...(snapshot.mcpTools ?? []), ...(snapshot.subagentTools ?? [])]) {
    const toolset = inferToolset(tool);
    const existing = groups.get(toolset) ?? { toolCount: 0, schemaTokens: 0 };
    existing.toolCount += 1;
    existing.schemaTokens += estimateTokens(JSON.stringify(tool));
    groups.set(toolset, existing);
  }

  const toolsets: ContextToolsetDetail[] = Array.from(groups.entries())
    .map(([toolset, meta]) => ({ toolset, toolCount: meta.toolCount, schemaTokens: meta.schemaTokens }))
    .sort((a, b) => b.schemaTokens - a.schemaTokens);

  return { skills, toolsets };
}

export function formatContextGrid(categories: readonly ContextBreakdownCategory[]): string {
  const total = categories.reduce((sum, c) => sum + c.tokens, 0);
  if (total === 0) return "·".repeat(100);

  const cells = Array<string>(100).fill("·");
  const glyphs = ["■", "▣", "▩", "▤", "▥", "▦", "▧", "▨"];

  // Allocate cells proportionally. Categories with any tokens get at least one
  // cell so they remain visible in the 100-cell grid.
  let allocated = 0;
  const allocations: { index: number; count: number }[] = [];
  for (let i = 0; i < categories.length; i += 1) {
    const cat = categories[i];
    if (cat.tokens <= 0) continue;
    const share = Math.floor((cat.tokens / total) * 100);
    const count = Math.max(1, share);
    allocations.push({ index: i, count });
    allocated += count;
  }

  // Trim or expand to exactly 100 cells, preserving at least one per non-empty category.
  if (allocated > 100) {
    let over = allocated - 100;
    for (let i = allocations.length - 1; i >= 0 && over > 0; i -= 1) {
      const canRemove = allocations[i].count - 1;
      const remove = Math.min(canRemove, over);
      allocations[i].count -= remove;
      over -= remove;
      if (allocations[i].count <= 0) allocations.splice(i, 1);
    }
  } else if (allocated < 100) {
    const remaining = 100 - allocated;
    if (allocations.length > 0) {
      allocations[0].count += remaining;
    }
  }

  let cursor = 0;
  for (const { index, count } of allocations) {
    const glyph = glyphs[index % glyphs.length];
    for (let i = 0; i < count && cursor < 100; i += 1) {
      cells[cursor] = glyph;
      cursor += 1;
    }
  }

  const rows: string[] = [];
  for (let r = 0; r < 5; r += 1) {
    rows.push(cells.slice(r * 20, (r + 1) * 20).join(""));
  }
  return rows.join("\n");
}

export function formatContextCategoryLines(breakdown: ContextBreakdown): string[] {
  const lines: string[] = [];
  const total = breakdown.categories.reduce((sum, c) => sum + c.tokens, 0);
  for (const cat of breakdown.categories) {
    const pct = total > 0 ? (cat.tokens / total) * 100 : 0;
    lines.push(`${cat.label.padEnd(24)} ${String(cat.tokens).padStart(6)} tokens  ${pct.toFixed(1).padStart(5)}%`);
  }
  const free = Math.max(0, breakdown.contextMax - breakdown.contextUsed);
  lines.push("-".repeat(50));
  lines.push(`${"Free space".padEnd(24)} ${String(Math.round(free)).padStart(6)} tokens  ${(100 - breakdown.contextPercent).toFixed(1).padStart(5)}%`);
  return lines;
}

export function formatContextDetails(details: ContextDetails): string[] {
  const lines: string[] = [];
  if (details.skills.length > 0) {
    lines.push("Skills:");
    for (const skill of details.skills.slice(0, 15)) {
      lines.push(`  ${skill.name.padEnd(24)} idx ${skill.indexTokens} tok${skill.skillMdTokens !== null ? `, md ${skill.skillMdTokens} tok` : ""}`);
    }
  }
  if (details.toolsets.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Toolsets:");
    for (const ts of details.toolsets.slice(0, 15)) {
      lines.push(`  ${ts.toolset.padEnd(24)} ${String(ts.toolCount).padStart(3)} tools  ${String(ts.schemaTokens).padStart(6)} tokens`);
    }
  }
  return lines;
}

export interface FormatContextOptions {
  all?: boolean;
  grid?: boolean;
}

export function formatContextOutput(breakdown: ContextBreakdown, options: FormatContextOptions = {}): string {
  const lines: string[] = [];
  const model = breakdown.model ?? "unknown";
  lines.push(`🧠 Context Usage — ${model}`);
  lines.push(`窗口: ${breakdown.contextUsed} / ${breakdown.contextMax} tokens (${breakdown.contextPercent.toFixed(1)}%)`);
  lines.push("");

  if (options.grid !== false) {
    lines.push(formatContextGrid(breakdown.categories));
    lines.push("");
  }

  lines.push(...formatContextCategoryLines(breakdown));

  if (options.all && (breakdown.details.skills.length > 0 || breakdown.details.toolsets.length > 0)) {
    lines.push("");
    lines.push(...formatContextDetails(breakdown.details));
  }

  return lines.join("\n");
}
