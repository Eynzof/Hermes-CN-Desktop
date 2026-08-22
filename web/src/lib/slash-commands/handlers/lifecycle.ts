import type { SessionMessage, SessionSummary } from "@hermes/protocol";
import type { SessionStore } from "@/lib/session-store/session-store";
import type { CommandResult } from "../types";

export interface CommandContext {
  store: SessionStore;
  activeSessionId: string | null;
  /** Submit a user prompt to the current runtime (agent-core or gateway). */
  submitPrompt: (sessionId: string, prompt: string) => Promise<void>;
  /** Cancel the currently running turn. */
  cancelTurn: () => Promise<void>;
  /** Surface-agnostic status output (toast, status bar, etc). */
  notify: (message: string) => void;
  /** Current working directory, if known. */
  cwd?: string | null;
}

function ok(output: string, extras?: Partial<CommandResult>): CommandResult {
  return { type: "exec", output, ...extras };
}

function err(message: string): CommandResult {
  return { type: "error", message };
}

function parseArgs(raw: string): { tokens: string[]; rest: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  return { tokens, rest: raw.trim() };
}

/**
 * `/new` / `/reset [name] [now]` — start a fresh session and make it active.
 */
export async function handleNew(args: string, ctx: CommandContext): Promise<CommandResult> {
  const { tokens } = parseArgs(args);
  const name = tokens[0];
  const session = await ctx.store.create({
    title: name,
    cwd: ctx.cwd ?? undefined,
  });
  return ok(`Started new session ${session.id}`, { activeSessionId: session.id });
}

/**
 * `/clear` — clear the current view and start a new session.
 */
export async function handleClear(args: string, ctx: CommandContext): Promise<CommandResult> {
  const result = await handleNew(args, ctx);
  return {
    ...result,
    clearView: true,
    output: `Cleared view. ${result.output ?? ""}`,
    type: "exec",
  };
}

/**
 * `/history` — return a transcript summary of the active session.
 */
export async function handleHistory(_args: string, ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) return err("No active session");
  const session = await ctx.store.get(ctx.activeSessionId);
  if (!session) return err("Session not found");
  const messages = await ctx.store.getMessages(ctx.activeSessionId);
  const lines = messages.map((m) => `${m.role}: ${m.content ?? ""}`.trim()).join("\n");
  return ok(`History for ${session.title ?? session.id} (${messages.length} messages)`, {
    export: { format: "text", content: lines },
  });
}

/**
 * `/save [format]` — export the current conversation as Markdown.
 */
export async function handleSave(args: string, ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) return err("No active session");
  const session = await ctx.store.get(ctx.activeSessionId);
  if (!session) return err("Session not found");
  const messages = await ctx.store.getMessages(ctx.activeSessionId);
  const format = parseArgs(args).tokens[0] ?? "md";
  const content = exportConversation(session, messages, format);
  return ok(`Exported ${messages.length} messages as ${format}`, { export: { format, content } });
}

/**
 * `/resume <number|title|id>` — switch to an existing session, following
 * compression tips to the message-bearing descendant.
 */
export async function handleResume(args: string, ctx: CommandContext): Promise<CommandResult> {
  const target = args.trim();
  if (!target) return err("Please provide a session number, title, or id");

  const resolved = await ctx.store.resolveSessionId(target);
  const sessionId = resolved ?? target;
  const session = await ctx.store.get(sessionId);
  if (!session) return err(`Session ${target} not found`);

  const tipId = await ctx.store.resolveResumeSessionId(sessionId);
  if (tipId !== sessionId) {
    ctx.notify(`Resumed compression tip ${tipId}`);
  }

  return ok(`Resumed session ${tipId}`, { activeSessionId: tipId });
}

/**
 * `/sessions` / `/switch [target]` — list sessions or switch to a target.
 */
export async function handleSessions(args: string, ctx: CommandContext): Promise<CommandResult> {
  const target = args.trim();
  if (target) {
    return handleResume(args, ctx);
  }
  const list = await ctx.store.list({ limit: 20, offset: 0 });
  const lines = list.sessions
    .map((s, i) => `${i + 1}. ${s.title ?? s.id} (${s.message_count} messages)`)
    .join("\n");
  return ok(`Sessions:\n${lines || "No sessions"}`);
}

/**
 * `/title [name]` — rename the current session.
 */
export async function handleTitle(args: string, ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) return err("No active session");
  const name = args.trim();
  const session = await ctx.store.get(ctx.activeSessionId);
  if (!session) return err("Session not found");

  if (!name) {
    return ok(`Current title: ${session.title ?? session.id}`);
  }

  await ctx.store.setTitle(ctx.activeSessionId, name);
  return ok(`Renamed session to "${name}"`);
}

/**
 * `/branch` / `/fork [name]` — fork the current session.
 */
export async function handleBranch(args: string, ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) return err("No active session");
  const name = args.trim() || undefined;
  const branch = await ctx.store.fork(ctx.activeSessionId, { name, cwd: ctx.cwd ?? undefined });
  return ok(`Branched to ${branch.id}${name ? ` (${name})` : ""}`, { activeSessionId: branch.id });
}

/**
 * `/retry` — resend the last user message.
 */
export async function handleRetry(_args: string, ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) return err("No active session");
  const messages = await ctx.store.getMessages(ctx.activeSessionId);
  const lastUser = findLastUserMessage(messages);
  if (!lastUser) return err("No user message to retry");

  // Rewind to the last user message and re-submit it.
  await ctx.store.rewindToMessage(ctx.activeSessionId, lastUser.id as number);
  return ok(`Retrying: ${lastUser.content ?? ""}`, { pendingPrompt: lastUser.content ?? "" });
}

/**
 * `/undo [N]` — remove the last N exchanges.
 */
export async function handleUndo(args: string, ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) return err("No active session");
  const n = Math.max(1, parseInt(parseArgs(args).tokens[0] ?? "1", 10));
  const messages = await ctx.store.getMessages(ctx.activeSessionId);
  const target = findNthLastExchange(messages, n);
  if (!target) return err(`No exchange to undo (only ${messages.length} messages)`);

  const result = await ctx.store.rewindToMessage(ctx.activeSessionId, target.id as number);
  return ok(
    `Undid ${n} exchange(s). Removed ${result.deletedCount} message(s).`,
    result.targetMessage?.content ? { pendingPrompt: result.targetMessage.content } : undefined,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function findLastUserMessage(messages: SessionMessage[]): SessionMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i];
  }
  return undefined;
}

function findNthLastExchange(messages: SessionMessage[], n: number): SessionMessage | undefined {
  let exchanges = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      exchanges++;
      if (exchanges === n) return messages[i];
    }
  }
  return undefined;
}

function exportConversation(session: SessionSummary, messages: SessionMessage[], format: string): string {
  if (format === "json" || format === "jsonl") {
    return messages.map((m) => JSON.stringify({ role: m.role, content: m.content })).join("\n");
  }
  // Default Markdown.
  const title = session.title ?? session.id;
  const header = `# ${title}\n\n`;
  const body = messages
    .map((m) => {
      const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
      return `## ${role}\n\n${m.content ?? ""}`;
    })
    .join("\n\n");
  return header + body;
}
