import { describe, expect, it } from "vitest";
import { LearningJourney, RECALL_INTERVALS_MS } from "./journey.js";

describe("LearningJourney", () => {
  it("adds a topic", () => {
    const journey = new LearningJourney();
    const topic = journey.addTopic("TypeScript", "Learning TypeScript basics", 1000);
    expect(topic.name).toBe("TypeScript");
    expect(topic.description).toBe("Learning TypeScript basics");
    expect(topic.createdAt).toBe(1000);
    expect(topic.intervalIndex).toBe(0);
    expect(topic.recallCount).toBe(0);
  });

  it("lists topics by updated order", () => {
    const journey = new LearningJourney();
    journey.addTopic("A", undefined, 1000);
    const b = journey.addTopic("B", undefined, 2000);
    journey.addMilestone(b.id, "m1", "content", "manual", undefined, 3000);
    const topics = journey.getTopics();
    expect(topics).toHaveLength(2);
    expect(topics[0]?.name).toBe("B");
    expect(topics[1]?.name).toBe("A");
  });

  it("throws when adding a milestone to a missing topic", () => {
    const journey = new LearningJourney();
    expect(() => journey.addMilestone("missing", "t", "c", "manual")).toThrow("missing");
  });

  it("records successful recall and advances interval", () => {
    const journey = new LearningJourney();
    const topic = journey.addTopic("Rust", undefined, 0);
    const updated = journey.recordRecall(topic.id, true, 1000);
    expect(updated.intervalIndex).toBe(1);
    expect(updated.recallCount).toBe(1);
    expect(updated.lastReviewedAt).toBe(1000);
    expect(updated.nextReviewAt).toBe(1000 + RECALL_INTERVALS_MS[1]);
  });

  it("records failed recall and regresses interval", () => {
    const journey = new LearningJourney();
    const topic = journey.addTopic("Rust", undefined, 0);
    journey.recordRecall(topic.id, true, 1000);
    journey.recordRecall(topic.id, true, 2000);
    const updated = journey.recordRecall(topic.id, false, 3000);
    expect(updated.intervalIndex).toBe(1);
    expect(updated.recallCount).toBe(2);
  });

  it("does not regress below zero", () => {
    const journey = new LearningJourney();
    const topic = journey.addTopic("Rust", undefined, 0);
    const updated = journey.recordRecall(topic.id, false, 1000);
    expect(updated.intervalIndex).toBe(0);
    expect(updated.recallCount).toBe(0);
  });

  it("clamps intervals at the maximum", () => {
    const journey = new LearningJourney();
    const topic = journey.addTopic("Rust", undefined, 0);
    for (let i = 0; i < RECALL_INTERVALS_MS.length + 5; i++) {
      journey.recordRecall(topic.id, true, i * 1000);
    }
    const t = journey.getTopics()[0]!;
    expect(t.intervalIndex).toBe(RECALL_INTERVALS_MS.length - 1);
  });

  it("returns due reviews sorted by next review time", () => {
    const journey = new LearningJourney();
    const a = journey.addTopic("A", undefined, 0);
    const b = journey.addTopic("B", undefined, 0);
    journey.scheduleTopic(a.id, 1500);
    journey.scheduleTopic(b.id, 1000);
    const due = journey.getDueReviews(2000);
    expect(due.map((t) => t.name)).toEqual(["B", "A"]);
  });

  it("includes topics without a schedule as due", () => {
    const journey = new LearningJourney();
    journey.addTopic("A", undefined, 0);
    const due = journey.getDueReviews(1000);
    expect(due).toHaveLength(1);
  });

  it("snapshot includes topics, milestones, and due topics", () => {
    const journey = new LearningJourney();
    const topic = journey.addTopic("A", undefined, 0);
    journey.addMilestone(topic.id, "m1", "c", "manual", undefined, 100);
    const snapshot = journey.snapshot(1000);
    expect(snapshot.topics).toHaveLength(1);
    expect(snapshot.milestones).toHaveLength(1);
    expect(snapshot.dueTopics).toHaveLength(1);
  });
});
