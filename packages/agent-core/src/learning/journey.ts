/**
 * In-process learning journey service.
 *
 * Tracks topics, milestones, and spaced-repetition recall intervals for the
 * desktop `/journey` slash command.
 */

import type { LearningJourneySnapshot, LearningMilestone, LearningSource, LearningTopic } from "./types.js";

/** Default spaced-repetition intervals in milliseconds: 1d, 3d, 7d, 14d, 30d. */
export const RECALL_INTERVALS_MS = [
  24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  14 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
];

function nextIntervalMs(index: number): number {
  const clamped = Math.max(0, Math.min(index, RECALL_INTERVALS_MS.length - 1));
  return RECALL_INTERVALS_MS[clamped]!;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export class LearningJourney {
  private readonly topics = new Map<string, LearningTopic>();
  private readonly milestones = new Map<string, LearningMilestone>();

  /**
   * Create a new learning topic.
   * @param name topic name
   * @param description optional description
   * @param now optional timestamp (defaults to Date.now())
   */
  addTopic(name: string, description?: string, now = Date.now()): LearningTopic {
    const id = `topic:${now}:${randomSuffix()}`;
    const topic: LearningTopic = {
      id,
      name: name.trim(),
      description,
      createdAt: now,
      updatedAt: now,
      intervalIndex: 0,
      recallCount: 0,
    };
    this.topics.set(id, topic);
    return topic;
  }

  /**
   * Add a milestone under a topic.
   * @param topicId parent topic id
   * @param title milestone title
   * @param content milestone body
   * @param source origin source
   * @param sourceId optional originating memory/session id
   * @param now optional timestamp
   */
  addMilestone(
    topicId: string,
    title: string,
    content: string,
    source: LearningSource,
    sourceId?: string,
    now = Date.now(),
  ): LearningMilestone {
    const topic = this.topics.get(topicId);
    if (!topic) {
      throw new Error(`Topic ${topicId} not found`);
    }
    const id = `milestone:${now}:${randomSuffix()}`;
    const milestone: LearningMilestone = {
      id,
      topicId,
      title: title.trim(),
      content: content.trim(),
      timestamp: now,
      source,
      sourceId,
    };
    this.milestones.set(id, milestone);
    topic.updatedAt = now;
    this.topics.set(topicId, topic);
    return milestone;
  }

  /**
   * Record a recall/review event for spaced repetition.
   * @param topicId topic id
   * @param success whether the recall was successful
   * @param now optional timestamp
   */
  recordRecall(topicId: string, success: boolean, now = Date.now()): LearningTopic {
    const topic = this.topics.get(topicId);
    if (!topic) {
      throw new Error(`Topic ${topicId} not found`);
    }
    topic.lastReviewedAt = now;
    if (success) {
      topic.intervalIndex = Math.min(topic.intervalIndex + 1, RECALL_INTERVALS_MS.length - 1);
      topic.recallCount += 1;
    } else {
      topic.intervalIndex = Math.max(0, topic.intervalIndex - 1);
    }
    topic.nextReviewAt = now + nextIntervalMs(topic.intervalIndex);
    topic.updatedAt = now;
    this.topics.set(topicId, topic);
    return topic;
  }

  /**
   * Override the next review time for a topic.
   * @param topicId topic id
   * @param nextReviewAt next review timestamp (Unix ms)
   */
  scheduleTopic(topicId: string, nextReviewAt: number): LearningTopic {
    const topic = this.topics.get(topicId);
    if (!topic) {
      throw new Error(`Topic ${topicId} not found`);
    }
    topic.nextReviewAt = nextReviewAt;
    topic.updatedAt = Date.now();
    this.topics.set(topicId, topic);
    return topic;
  }

  /** Return all topics sorted by most recently updated first. */
  getTopics(): LearningTopic[] {
    return Array.from(this.topics.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Return milestones, optionally filtered by topic. */
  getMilestones(topicId?: string): LearningMilestone[] {
    const list = topicId
      ? Array.from(this.milestones.values()).filter((m) => m.topicId === topicId)
      : Array.from(this.milestones.values());
    return list.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Return topics due for review at or before `now`. */
  getDueReviews(now = Date.now()): LearningTopic[] {
    return this.getTopics()
      .filter((t) => t.nextReviewAt === undefined || t.nextReviewAt <= now)
      .sort((a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0));
  }

  /** Full snapshot of the journey. */
  snapshot(now = Date.now()): LearningJourneySnapshot {
    return {
      topics: this.getTopics(),
      milestones: this.getMilestones(),
      dueTopics: this.getDueReviews(now),
    };
  }
}
