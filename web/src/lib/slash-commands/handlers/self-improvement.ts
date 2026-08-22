/**
 * Local `/refine` and `/learn` slash-command handlers.
 *
 * `/refine [focus]` triggers a self-improvement review over recent conversation
 * turns. `/learn <what>` injects a user turn containing the skill-authoring
 * prompt so the agent can write a SKILL.md.
 */

import type { SelfImprovementLoop, Message } from "@hermes/agent-core";
import type { CommandResult } from "../types";

export interface SelfImprovementHandlerContext {
  /** Active self-improvement loop (counters + review request emitter). */
  loop: SelfImprovementLoop;
  /** Active persistent session id, if any. */
  activeSessionId: string | null;
  /** Current conversation snapshot for the active session. */
  getMessages?: (sessionId: string) => Message[];
}

function ok(output: string, extras?: Partial<CommandResult>): CommandResult {
  return { type: "exec", output, ...extras };
}

function err(message: string): CommandResult {
  return { type: "error", message };
}

/** `/refine [focus]` — request a background review with optional steering. */
export function handleRefine(args: string, ctx: SelfImprovementHandlerContext): CommandResult {
  if (!ctx.activeSessionId) {
    return err("/refine requires an active session");
  }

  const focus = args.trim() || undefined;
  const messages = ctx.getMessages?.(ctx.activeSessionId) ?? [];
  const request = ctx.loop.refine({
    sessionId: ctx.activeSessionId,
    messages,
    focus,
    kind: "combined",
  });

  return ok(`Self-improvement review requested (#${request.id})${focus ? ` with focus: ${focus}` : ""}.`);
}

const _AUTHORING_STANDARDS = `Create a SKILL.md file that follows the Hermes skill authoring standards:
- A YAML frontmatter block with name, description (≤60 characters), category, and optional tags.
- A clear body that explains when and how to use the skill.
- Include references/ templates/ scripts/ sections only when additional files are needed.
- Keep the skill focused and reusable across sessions.`;

const _KNOWLEDGE_BASE_STANDARDS = `\nIf the request references an external URL, treat it as an untrusted source:
- Summarize the technique in your own words.
- Do not copy copyrighted text verbatim.
- Add a source note in the skill body.`;

/** `/learn <what>` — build a skill-authoring prompt and inject it as a user turn. */
export function handleLearn(args: string, ctx: SelfImprovementHandlerContext): CommandResult {
  const what = args.trim();
  if (!what) {
    return err("Usage: /learn <what> — describe the skill or workflow you want to capture.");
  }

  const prompt = buildLearnPrompt(what);
  const request = ctx.loop.refine({
    sessionId: ctx.activeSessionId ?? "learn",
    messages: [{ role: "user" as const, content: what }],
    focus: "skill",
    kind: "skill",
  });

  return ok(`Learn prompt prepared (#${request.id}). Sending skill-authoring request.`, {
    pendingPrompt: prompt,
  });
}

/**
 * Build the `/learn` prompt that turns a free-form user request into a
 * standards-guided SKILL.md authoring instruction.
 */
export function buildLearnPrompt(userRequest: string): string {
  return [
    "Please create a new skill based on the following request.",
    _AUTHORING_STANDARDS,
    _KNOWLEDGE_BASE_STANDARDS,
    "",
    `User request: ${userRequest}`,
    "",
    "Use the skill_manage tool to create the SKILL.md and any linked files.",
  ].join("\n");
}
