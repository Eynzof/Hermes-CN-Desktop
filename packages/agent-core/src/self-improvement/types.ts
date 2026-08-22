/**
 * Data types for the self-improvement loop.
 *
 * Mirrors the Python review fork surface: review requests, improvement patches,
 * nudge counters, write-approval gate decisions, and staged pending writes.
 */

import type { Message } from "../types.js";

/** Which subsystem(s) the review should target. */
export type ReviewKind = "memory" | "skill" | "combined";

/** Origin of a write so the approval gate can treat background reviews differently. */
export type WriteOrigin = "foreground" | "background_review";

/** Result of an approval-gate evaluation. */
export interface GateDecision {
  /** Gate outcome. */
  decision: "allow" | "stage" | "block";
  /** Human-readable explanation. */
  reason: string;
}

/** A single staged write waiting for approval. */
export interface PendingWrite {
  /** Stable identifier (same as the file name without extension). */
  id: string;
  /** Subsystem that owns the write. */
  subsystem: "memory" | "skills";
  /** Action name, e.g. add_memory / skill_manage.create. */
  action: string;
  /** Short human-readable summary for UI lists. */
  summary: string;
  /** Where the write originated. */
  origin: WriteOrigin;
  /** ISO timestamp of when the write was staged. */
  createdAt: string;
  /** Opaque payload that the approved write will replay. */
  payload: Record<string, unknown>;
}

/** Request to run a background review against a conversation snapshot. */
export interface ReviewRequest {
  /** Unique review id. */
  id: string;
  /** Parent session that produced the snapshot. */
  sessionId: string;
  /** Which subsystem(s) to review. */
  kind: ReviewKind;
  /** Conversation snapshot to replay. */
  messages: readonly Message[];
  /** Optional user-supplied steering focus (from `/refine [focus]`). */
  focus?: string;
  /** Whether the review should run quietly without live UI messages. */
  quiet?: boolean;
  /** Origin marker applied to any writes produced by the review. */
  origin?: WriteOrigin;
}

/** A concrete improvement produced by a review. */
export interface ImprovementPatch {
  /** Patch id unique within the review result. */
  id: string;
  /** Target subsystem. */
  subsystem: "memory" | "skills";
  /** Action name. */
  action: string;
  /** Stable target id or name (memory entry text, skill id, etc.). */
  target: string;
  /** Short summary for UI / toasts. */
  summary: string;
  /** Full payload the gate will evaluate. */
  payload: Record<string, unknown>;
}

/** Result returned when a review finishes. */
export interface ReviewResult {
  /** Id of the originating request. */
  requestId: string;
  /** Patches emitted by the review fork. */
  patches: ImprovementPatch[];
  /** One-line summary for the "💾 Self-improvement review: …" toast. */
  summary: string;
}

/** Nudge counters that drive background review scheduling. */
export interface NudgeCounters {
  turnsSinceMemory: number;
  itersSinceSkill: number;
}

/** Configuration for nudge intervals and the write-approval gate. */
export interface SelfImprovementConfig {
  /** Turns between memory reviews (default 10). */
  memoryNudgeInterval: number;
  /** Tool iterations between skill reviews (default 10). */
  skillNudgeInterval: number;
  /** Whether memory writes require approval. */
  memoryWriteApproval: boolean;
  /** Whether skill writes require approval. */
  skillWriteApproval: boolean;
}

/** Shape emitted by `SelfImprovementLoop` event callbacks. */
export interface SelfImprovementEventMap {
  "self-improvement.review.requested": { request: ReviewRequest };
  "self-improvement.review.completed": { result: ReviewResult; request: ReviewRequest };
  "self-improvement.review.cancelled": { requestId: string };
  "self-improvement.pending.changed": { subsystem: "memory" | "skills"; count: number };
}

/** Listener signature for typed events. */
export type SelfImprovementEventListener<K extends keyof SelfImprovementEventMap> = (
  event: SelfImprovementEventMap[K],
) => void | Promise<void>;
