/**
 * Data types for the learning-journey feature.
 *
 * Mirrors the lightweight in-process graph model used by the desktop
 * `/journey` slash command and the `LearningJourneyPanel` React component.
 */

/** Where a milestone or node originated. */
export type LearningSource = "memory" | "session" | "manual";

/** A learning topic tracked by the user or derived from memory/session data. */
export interface LearningTopic {
  /** Stable topic id. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Optional longer description. */
  description?: string;
  /** Topic creation timestamp (Unix ms). */
  createdAt: number;
  /** Last update timestamp (Unix ms). */
  updatedAt: number;
  /** Spaced-repetition interval index (0 = new). */
  intervalIndex: number;
  /** Last successful review timestamp (Unix ms). */
  lastReviewedAt?: number;
  /** Next scheduled review timestamp (Unix ms). */
  nextReviewAt?: number;
  /** Number of successful recalls. */
  recallCount: number;
}

/** A milestone tied to a learning topic. */
export interface LearningMilestone {
  id: string;
  topicId: string;
  title: string;
  content: string;
  timestamp: number;
  source: LearningSource;
  /** Optional reference to the originating memory/session id. */
  sourceId?: string;
}

/** A node in the memory graph. */
export interface MemoryGraphNode {
  id: string;
  kind: "topic" | "milestone" | "memory" | "session";
  label: string;
  timestamp?: number;
  /** Source scope for memory/session nodes. */
  source?: string;
  /** Extra metadata (importance, token counts, etc.). */
  metadata?: Record<string, unknown>;
}

/** A weighted edge in the memory graph. */
export interface MemoryGraphEdge {
  source: string;
  target: string;
  kind: "recall" | "related" | "keyword" | "contained";
  /** Edge weight in [0, 1]. */
  weight: number;
}

/** Snapshot of the current learning journey. */
export interface LearningJourneySnapshot {
  topics: LearningTopic[];
  milestones: LearningMilestone[];
  dueTopics: LearningTopic[];
}

/** Built memory graph with summary statistics. */
export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    topicCount: number;
    memoryCount: number;
    sessionCount: number;
  };
}
