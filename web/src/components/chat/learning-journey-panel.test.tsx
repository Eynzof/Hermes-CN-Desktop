// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LearningJourneyPanel } from "./learning-journey-panel";
import type { LearningJourneySnapshot, MemoryGraph } from "@hermes/agent-core";

const sampleSnapshot: LearningJourneySnapshot = {
  topics: [
    {
      id: "topic:1:a",
      name: "TypeScript",
      description: "Learning TypeScript basics",
      createdAt: 0,
      updatedAt: 1000,
      intervalIndex: 1,
      recallCount: 2,
      nextReviewAt: 86400000,
    },
  ],
  milestones: [],
  dueTopics: [
    {
      id: "topic:1:a",
      name: "TypeScript",
      createdAt: 0,
      updatedAt: 1000,
      intervalIndex: 1,
      recallCount: 2,
    },
  ],
};

afterEach(cleanup);

const sampleGraph: MemoryGraph = {
  nodes: [
    { id: "memory:memory:0", kind: "memory", label: "hello world memory", source: "memory" },
    { id: "session:a", kind: "session", label: "test session", source: "test" },
  ],
  edges: [{ source: "session:a", target: "memory:memory:0", kind: "related", weight: 0.5 }],
  stats: { nodeCount: 2, edgeCount: 1, topicCount: 0, memoryCount: 1, sessionCount: 1 },
};

describe("LearningJourneyPanel", () => {
  it("renders empty state when no data", () => {
    render(<LearningJourneyPanel snapshot={null} graph={null} />);
    expect(screen.getByText("No learning journey data available.")).toBeDefined();
  });

  it("renders journey tab by default", () => {
    render(<LearningJourneyPanel snapshot={sampleSnapshot} graph={sampleGraph} />);
    expect(screen.getByText("Learning Journey")).toBeDefined();
    expect(screen.getByText("TypeScript")).toBeDefined();
    expect(screen.getByText("Learning TypeScript basics")).toBeDefined();
    expect(screen.getByText("1 due")).toBeDefined();
  });

  it("switches to graph tab", () => {
    render(<LearningJourneyPanel snapshot={sampleSnapshot} graph={sampleGraph} />);
    fireEvent.click(screen.getByRole("tab", { name: "Memory Graph" }));
    expect(screen.getByText("Nodes: 2")).toBeDefined();
    expect(screen.getByText("Edges: 1")).toBeDefined();
    expect(screen.getByText(/hello world memory/)).toBeDefined();
    expect(screen.getByText(/test session/)).toBeDefined();
  });

  it("shows empty journey message when snapshot has no topics", () => {
    render(<LearningJourneyPanel snapshot={{ topics: [], milestones: [], dueTopics: [] }} graph={sampleGraph} />);
    expect(screen.getByText("No learning yet — keep using Hermes and it maps out here.")).toBeDefined();
  });

  it("shows empty graph message when graph is null", () => {
    render(<LearningJourneyPanel snapshot={sampleSnapshot} graph={null} />);
    fireEvent.click(screen.getByRole("tab", { name: "Memory Graph" }));
    expect(screen.getByText("No memory graph data available.")).toBeDefined();
  });
});
