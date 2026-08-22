import {
  type CronScheduler,
  type GoalStore,
  type HeartbeatLoop,
  type KanbanStore,
  type CuratorEngine,
  type BlueprintLibrary,
  type SubagentPool,
  parseCronExpression,
} from "@hermes/agent-core";
import type { CommandResult } from "../types";

export interface HeartbeatHandlerContext {
  loop: HeartbeatLoop;
  activeSessionId: string | null;
}

export function handleHeartbeat(args: string, ctx: HeartbeatHandlerContext): CommandResult {
  if (!ctx.activeSessionId) return { type: "error", message: "/heartbeat requires an active session" };
  const trimmed = args.trim();
  if (trimmed.toLowerCase() === "off") {
    const out = ctx.loop.cancel(ctx.activeSessionId);
    return { type: "exec", output: out };
  }
  const m = trimmed.match(/^(\S+)\s+(.+)$/);
  if (!m) return { type: "error", message: "Usage: /heartbeat <interval> <prompt>|off" };
  try {
    const out = ctx.loop.set(ctx.activeSessionId, m[1], m[2]);
    return { type: "exec", output: out };
  } catch (err) {
    return { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export interface GoalHandlerContext {
  store: GoalStore;
  activeSessionId: string | null;
}

export function handleGoal(args: string, ctx: GoalHandlerContext): CommandResult {
  if (!ctx.activeSessionId) return { type: "error", message: "/goal requires an active session" };
  const trimmed = args.trim();
  if (!trimmed || trimmed.toLowerCase() === "status") {
    const goal = ctx.store.get(ctx.activeSessionId);
    return { type: "exec", output: goal ? JSON.stringify(goal, null, 2) : "No active goal" };
  }
  if (trimmed.toLowerCase() === "off") {
    ctx.store.setStatus(ctx.activeSessionId, "completed");
    return { type: "exec", output: "Goal cleared" };
  }
  ctx.store.set(ctx.activeSessionId, trimmed);
  return { type: "exec", output: `Goal set: ${trimmed}` };
}

export function handleSubgoal(args: string, ctx: GoalHandlerContext): CommandResult {
  if (!ctx.activeSessionId) return { type: "error", message: "/subgoal requires an active session" };
  const text = args.trim();
  if (!text) return { type: "error", message: "Usage: /subgoal <sub-goal>" };
  const sub = ctx.store.addSubGoal(ctx.activeSessionId, text);
  if (!sub) return { type: "error", message: "No active goal to attach subgoal to" };
  return { type: "exec", output: `Sub-goal added: ${sub.text}` };
}

export interface SubagentHandlerContext {
  pool: SubagentPool;
  activeSessionId: string | null;
}

export async function handleDelegate(args: string, ctx: SubagentHandlerContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) return { type: "error", message: "/delegate requires an active session" };
  const m = args.trim().match(/^(\S+)\s+(.+)$/);
  if (!m) return { type: "error", message: "Usage: /delegate <agent> <task>" };
  const result = await ctx.pool.dispatch({ agentId: m[1], task: m[2] });
  return { type: "exec", output: `[${result.agentId}] ${result.ok ? "OK" : "FAILED"}: ${result.output}` };
}

export interface CronHandlerContext {
  scheduler: CronScheduler;
  activeSessionId: string | null;
}

export function handleCron(args: string, ctx: CronHandlerContext): CommandResult {
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/);
  const sub = parts[0]?.toLowerCase();

  if (!sub || sub === "list") {
    const jobs = ctx.scheduler.list();
    return { type: "exec", output: jobs.map((j) => `${j.id}: ${j.schedule} -> ${j.prompt}`).join("\n") || "No cron jobs" };
  }

  if (sub === "add") {
    const rest = trimmed.slice(3).trim();
    const parsed = parseCronScheduleAndPrompt(rest);
    if (!parsed) return { type: "error", message: "Usage: /cron add <schedule> <prompt>" };
    try {
      const id = ctx.scheduler.add(parsed.schedule, parsed.prompt);
      return { type: "exec", output: `Cron job added: ${id}` };
    } catch (err) {
      return { type: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  if (sub === "remove" || sub === "cancel") {
    const id = parts[1];
    if (!id) return { type: "error", message: "Usage: /cron remove <id>" };
    const ok = ctx.scheduler.remove(id);
    return { type: "exec", output: ok ? `Removed ${id}` : `Not found: ${id}` };
  }

  return { type: "error", message: "Unknown /cron subcommand" };
}

export interface KanbanHandlerContext {
  store: KanbanStore;
  activeSessionId: string | null;
}

export function handleKanban(args: string, ctx: KanbanHandlerContext): CommandResult {
  const name = args.trim();
  if (!name || name.toLowerCase() === "list") {
    const boards = ctx.store.list();
    return { type: "exec", output: boards.map((b) => `${b.id}: ${b.name}`).join("\n") || "No boards" };
  }
  const board = ctx.store.createBoard(name);
  return { type: "exec", output: `Created kanban board ${board.id}: ${board.name}` };
}

export interface CuratorHandlerContext {
  engine: CuratorEngine;
  activeSessionId: string | null;
}

export async function handleCurator(args: string, ctx: CuratorHandlerContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) return { type: "error", message: "/curator requires an active session" };
  const sub = args.trim().toLowerCase() || "status";
  if (sub === "run") {
    const run = await ctx.engine.run(ctx.activeSessionId);
    return { type: "exec", output: `${run.status}: ${run.report}` };
  }
  return { type: "exec", output: "Curator ready. Use /curator run to snapshot." };
}

export interface AutomationHandlerContext {
  library: BlueprintLibrary;
  activeSessionId: string | null;
}

export function handleSuggestions(args: string, ctx: AutomationHandlerContext): CommandResult {
  const topic = args.trim() || "automation";
  // Import is deferred to avoid top-level cycles; generateSuggestions is a type-only import above.
  // We use a runtime placeholder that surfaces the blueprint count.
  const suggestions = ctx.library.match(topic).map((b) => b.name);
  return { type: "exec", output: `Suggestions for "${topic}": ${suggestions.join(", ") || "(none)"}` };
}

export function handleBlueprint(args: string, ctx: AutomationHandlerContext): CommandResult {
  const name = args.trim();
  if (!name) {
    const list = ctx.library.list();
    return { type: "exec", output: list.map((b) => `${b.name}: ${b.steps.join(" → ")}`).join("\n") || "No blueprints" };
  }
  const matches = ctx.library.match(name);
  if (!matches.length) return { type: "exec", output: `No blueprint matching "${name}"` };
  return { type: "exec", output: matches.map((b) => `${b.name}: ${b.steps.join(" → ")}`).join("\n") };
}

function parseCronScheduleAndPrompt(rest: string): { schedule: string; prompt: string } | undefined {
  const parts = rest.split(/\s+/);
  const tryPrefixes = [1, 2, 5];
  for (const n of tryPrefixes) {
    if (parts.length < n + 1) continue;
    const schedule = parts.slice(0, n).join(" ");
    const prompt = parts.slice(n).join(" ");
    if (parseCronExpression(schedule).valid) {
      return { schedule, prompt };
    }
  }
  return undefined;
}
