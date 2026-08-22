/**
 * `/refine [focus]` command implementation.
 *
 * Builds a review prompt from a conversation snapshot and an optional focus, then
 * returns either an immediate summary or a set of improvement patches for the
 * approval gate to stage or apply.
 */

import type { ImprovementPatch, ReviewKind, ReviewRequest, ReviewResult, WriteOrigin } from "./types.js";

export { type ReviewKind } from "./types.js";

export interface RefineCommandOptions {
  /** Optional user-supplied steering focus. */
  focus?: string;
  /** Origin marker for any patches produced. */
  origin?: WriteOrigin;
}

/** Build a review prompt appropriate to the review kind and focus. */
export function buildReviewPrompt(kind: ReviewKind, focus?: string): string {
  const base = _REVIEW_PROMPTS[kind];
  if (!focus) return base;
  return `${base}\n\nUser focus: ${focus}`;
}

const _MEMORY_REVIEW_PROMPT = `Review the conversation above and decide whether any facts about the user or project should be persisted to durable memory (MEMORY.md / USER.md).

Rules:
- Add concise, factual entries only (preferences, habits, project conventions, repeated errors).
- Do not duplicate entries already present in memory.
- If nothing is worth remembering, respond with a brief explanation and make no tool calls.`;

const _SKILL_REVIEW_PROMPT = `Review the conversation above and decide whether a reusable skill (SKILL.md) should be created or updated based on patterns you see.

Rules:
- Capture repeatable workflows, coding conventions, or troubleshooting steps.
- Keep descriptions under 60 characters.
- Do not overwrite bundled, hub, pinned, or user-owned skills without explicit consent.
- If no reusable pattern exists, respond with a brief explanation and make no tool calls.`;

const _COMBINED_REVIEW_PROMPT = `Review the conversation above and decide whether any facts should be persisted to memory (MEMORY.md / USER.md) and/or whether a reusable skill (SKILL.md) should be created or updated.

Rules:
- Memory: concise, factual entries only; no duplicates.
- Skills: capture repeatable workflows, coding conventions, or troubleshooting steps; keep descriptions under 60 characters.
- Do not overwrite bundled, hub, pinned, or user-owned skills without explicit consent.
- If nothing is worth changing, respond with a brief explanation and make no tool calls.`;

const _REVIEW_PROMPTS: Record<ReviewKind, string> = {
  memory: _MEMORY_REVIEW_PROMPT,
  skill: _SKILL_REVIEW_PROMPT,
  combined: _COMBINED_REVIEW_PROMPT,
};

/** A no-op review runner used by the stub refine command. */
export interface RefineReviewRunner {
  (request: ReviewRequest): Promise<ReviewResult>;
}

/** Result shape returned by the `/refine` command handler. */
export interface RefineCommandResult {
  request: ReviewRequest;
  prompt: string;
  result?: ReviewResult;
  summary: string;
}

/**
 * Execute `/refine [focus]`.
 *
 * Builds a review request, optionally runs it through `runner`, and returns a
 * human-readable summary plus any emitted patches.
 */
export async function refine(
  request: ReviewRequest,
  runner?: RefineReviewRunner,
): Promise<RefineCommandResult> {
  const prompt = buildReviewPrompt(request.kind, request.focus);
  const origin: WriteOrigin = request.origin ?? "foreground";

  if (!runner) {
    return {
      request,
      prompt,
      summary: `Refine review prepared (${request.kind}${request.focus ? `, focus: ${request.focus}` : ""}). Awaiting review runner.`,
    };
  }

  const result = await runner(request);
  const patches = result.patches.map<ImprovementPatch>((patch) => ({
    ...patch,
    payload: { ...patch.payload, _origin: origin },
  }));

  const summary =
    patches.length === 0
      ? "No refinements proposed."
      : `Proposed ${patches.length} improvement${patches.length === 1 ? "" : "s"}: ${patches.map((p) => p.summary).join("; ")}`;

  return { request, prompt, result: { ...result, patches }, summary };
}

/** Format a review result as the "💾 Self-improvement review" toast line. */
export function summarizeReviewActions(result: ReviewResult, mode: "off" | "on" | "verbose" = "on"): string {
  if (mode === "off") return "";
  if (result.patches.length === 0) return "💾 Self-improvement review: no changes.";
  const chunks = result.patches.map((p) => p.summary);
  if (mode === "verbose") {
    return `💾 Self-improvement review: ${result.summary} — ${chunks.join("; ")}`;
  }
  return `💾 Self-improvement review: ${chunks.join("; ")}`;
}
