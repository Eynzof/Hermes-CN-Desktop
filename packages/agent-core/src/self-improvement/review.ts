/**
 * `SelfImprovementLoop` — background memory/skill review scheduler.
 *
 * Scans recent sessions/tool iterations for refinement opportunities and emits
 * review requests. This is a TypeScript port of Python's background review fork
 * designed to run in-process alongside the desktop agent runtime.
 */

import type {
  NudgeCounters,
  ReviewKind,
  ReviewRequest,
  SelfImprovementConfig,
  SelfImprovementEventListener,
  SelfImprovementEventMap,
  WriteOrigin,
} from "./types.js";
import type { Message, Tool } from "../types.js";

export { type ReviewKind } from "./types.js";

/** Options for constructing a `SelfImprovementLoop`. */
export interface SelfImprovementLoopOptions {
  /** Mutable counters hydrated from the current session. */
  counters: NudgeCounters;
  /** Nudge intervals and gate configuration. */
  config: SelfImprovementConfig;
  /** Tools the loop is allowed to inspect for skill-iteration counting. */
  tools?: readonly Tool[];
  /** Optional listener for scheduled review requests. */
  onReviewRequested?: SelfImprovementEventListener<"self-improvement.review.requested">;
}

/** Default configuration matching the Python runtime defaults. */
export function defaultSelfImprovementConfig(): SelfImprovementConfig {
  return {
    memoryNudgeInterval: 10,
    skillNudgeInterval: 10,
    memoryWriteApproval: false,
    skillWriteApproval: false,
  };
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Turn-level and tool-level trigger logic for the self-improvement loop.
 *
 * The loop keeps two counters:
 * - `turnsSinceMemory` increments on each user turn and triggers a memory review
 *   when it reaches `memoryNudgeInterval`.
 * - `itersSinceSkill` increments on each tool iteration and is reset when the
 *   agent calls `skill_manage`; it triggers a skill review when it reaches
 *   `skillNudgeInterval`.
 */
export class SelfImprovementLoop {
  private readonly counters: NudgeCounters;
  private readonly config: SelfImprovementConfig;
  private readonly tools: readonly Tool[];
  private readonly listeners = new Map<
    keyof SelfImprovementEventMap,
    Set<SelfImprovementEventListener<keyof SelfImprovementEventMap>>
  >();

  constructor(options: SelfImprovementLoopOptions) {
    this.counters = options.counters;
    this.config = options.config;
    this.tools = options.tools ?? [];
    if (options.onReviewRequested) {
      this.on("self-improvement.review.requested", options.onReviewRequested);
    }
  }

  /** Current counter snapshot. */
  getCounters(): NudgeCounters {
    return { ...this.counters };
  }

  /** Register an event listener. */
  on<K extends keyof SelfImprovementEventMap>(
    event: K,
    listener: SelfImprovementEventListener<K>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set<SelfImprovementEventListener<keyof SelfImprovementEventMap>>();
      this.listeners.set(event, set);
    }
    set.add(listener as SelfImprovementEventListener<keyof SelfImprovementEventMap>);
    return () => set.delete(listener as SelfImprovementEventListener<keyof SelfImprovementEventMap>);
  }

  /** Increment the memory counter at the start of a user turn. */
  onUserTurnStart(): void {
    this.counters.turnsSinceMemory += 1;
  }

  /**
   * Increment the skill counter on each tool iteration.
   * Resets the counter when the tool is a skill-management tool.
   */
  onToolIteration(toolName: string): void {
    if (toolName === "skill_manage" || toolName === "skills") {
      this.counters.itersSinceSkill = 0;
      return;
    }
    this.counters.itersSinceSkill += 1;
  }

  /**
   * Decide whether a background review should run after a turn completes.
   * Returns a request when at least one counter crossed its interval, otherwise
   * `null`. Mutates counters by resetting the triggered ones.
   */
  maybeSpawnAfterTurn(ctx: {
    sessionId: string;
    messages: readonly Message[];
    interrupted?: boolean;
    skipBackgroundReview?: boolean;
    finalResponse?: string;
  }): ReviewRequest | null {
    if (ctx.interrupted) return null;
    if (ctx.skipBackgroundReview) return null;
    if (!ctx.finalResponse || ctx.finalResponse.trim().length === 0) return null;

    const shouldReviewMemory = this.counters.turnsSinceMemory >= this.config.memoryNudgeInterval;
    const shouldReviewSkills = this.counters.itersSinceSkill >= this.config.skillNudgeInterval;

    if (!shouldReviewMemory && !shouldReviewSkills) return null;

    const kind: ReviewKind = shouldReviewMemory && shouldReviewSkills ? "combined" : shouldReviewMemory ? "memory" : "skill";

    if (shouldReviewMemory) {
      this.counters.turnsSinceMemory = 0;
    }
    if (shouldReviewSkills) {
      this.counters.itersSinceSkill = 0;
    }

    const request: ReviewRequest = {
      id: randomId(),
      sessionId: ctx.sessionId,
      kind,
      messages: ctx.messages.slice(-24),
      origin: "background_review",
      quiet: true,
    };

    this.emit("self-improvement.review.requested", { request });
    return request;
  }

  /**
   * Manually trigger a review (used by `/refine [focus]`).
   * Always emits a review request, regardless of counter state.
   */
  refine(ctx: {
    sessionId: string;
    messages: readonly Message[];
    focus?: string;
    kind?: ReviewKind;
    origin?: WriteOrigin;
  }): ReviewRequest {
    const request: ReviewRequest = {
      id: randomId(),
      sessionId: ctx.sessionId,
      kind: ctx.kind ?? "combined",
      messages: ctx.messages.slice(-24),
      focus: ctx.focus,
      origin: ctx.origin ?? "foreground",
      quiet: false,
    };
    this.emit("self-improvement.review.requested", { request });
    return request;
  }

  /**
   * Scan the current tool list and recent messages for refinement opportunities.
   * Returns a plain-text diagnostic summary; the real review is emitted as a
   * `self-improvement.review.requested` event.
   */
  scanForRefinements(ctx: {
    sessionId: string;
    messages: readonly Message[];
    focus?: string;
  }): string {
    const memoryHints = this.findMemoryRefinementHints(ctx.messages);
    const skillHints = this.findSkillRefinementHints(this.tools, ctx.messages);

    const parts: string[] = [];
    if (memoryHints.length) {
      parts.push(`Memory refinements: ${memoryHints.join("; ")}`);
    }
    if (skillHints.length) {
      parts.push(`Skill refinements: ${skillHints.join("; ")}`);
    }
    if (!parts.length) {
      parts.push("No obvious refinements detected in recent turns.");
    }

    const request = this.refine({
      sessionId: ctx.sessionId,
      messages: ctx.messages,
      focus: ctx.focus,
      kind: "combined",
    });

    return `Review #${request.id} requested${ctx.focus ? ` (focus: ${ctx.focus})` : ""}. ${parts.join(" | ")}`;
  }

  /** Reset counters, e.g. on session switch. */
  resetCounters(): void {
    this.counters.turnsSinceMemory = 0;
    this.counters.itersSinceSkill = 0;
  }

  private findMemoryRefinementHints(messages: readonly Message[]): string[] {
    const hints: string[] = [];
    const recent = messages.slice(-6);
    const text = recent
      .map((m) => m.content)
      .filter((c): c is string => typeof c === "string")
      .join("\n");

    if (/\b(remember|memory|recall|note)\b/i.test(text)) {
      hints.push("user mentioned memory");
    }
    if (/\b(always|never|usually|sometimes)\b/i.test(text)) {
      hints.push("preference patterns detected");
    }
    return hints;
  }

  private findSkillRefinementHints(tools: readonly Tool[], messages: readonly Message[]): string[] {
    const hints: string[] = [];
    const toolNames = new Set(tools.map((t) => t.name));
    const recent = messages.slice(-6);
    for (const message of recent) {
      if (message.toolCalls) {
        for (const call of message.toolCalls) {
          if (toolNames.has(call.name) && call.name !== "memory" && call.name !== "skill_manage") {
            hints.push(`tool ${call.name} used`);
          }
        }
      }
    }
    return Array.from(new Set(hints));
  }

  private emit<K extends keyof SelfImprovementEventMap>(event: K, payload: SelfImprovementEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      // Intentionally fire-and-forget; synchronous listeners run immediately.
      const result = (listener as SelfImprovementEventListener<K>)(payload);
      if (result && typeof result.then === "function") {
        void result.catch(() => {
          /* ignore async listener errors */
        });
      }
    }
  }
}
