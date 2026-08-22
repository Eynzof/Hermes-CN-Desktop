import { describe, expect, it } from "vitest";
import { BoundedMemoryStore } from "../memory/store.js";
import { InMemorySessionStore } from "../session/store.js";
import type { ProfileSnapshot } from "../types.js";
import { buildMemoryGraph } from "./graph.js";

function makeProfile(): ProfileSnapshot {
  return {
    name: "default",
    model: "default",
    provider: "openai",
    apiMode: "chat_completions",
    hermesHome: "/tmp/hermes",
    createdAt: Date.now(),
  };
}

describe("buildMemoryGraph", () => {
  it("returns empty graph for empty stores", async () => {
    const memoryStore = new BoundedMemoryStore();
    const sessionStore = new InMemorySessionStore();
    const graph = await buildMemoryGraph({ memoryStore, sessionStore });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.stats).toEqual({
      nodeCount: 0,
      edgeCount: 0,
      topicCount: 0,
      memoryCount: 0,
      sessionCount: 0,
    });
  });

  it("creates nodes for memory entries", async () => {
    const memoryStore = new BoundedMemoryStore();
    memoryStore.load("memory", "hello world example\n§\nfoo bar example");
    const sessionStore = new InMemorySessionStore();
    const graph = await buildMemoryGraph({ memoryStore, sessionStore });
    expect(graph.stats.memoryCount).toBe(2);
    expect(graph.nodes.map((n) => n.kind)).toEqual(["memory", "memory"]);
  });

  it("creates nodes for sessions", async () => {
    const memoryStore = new BoundedMemoryStore();
    const sessionStore = new InMemorySessionStore();
    await sessionStore.createSession(makeProfile(), { title: "test session" });
    const graph = await buildMemoryGraph({ memoryStore, sessionStore });
    expect(graph.stats.sessionCount).toBe(1);
    expect(graph.nodes[0]?.kind).toBe("session");
    expect(graph.nodes[0]?.label).toBe("test session");
  });

  it("links memory nodes by shared keywords", async () => {
    const memoryStore = new BoundedMemoryStore();
    memoryStore.load("memory", "javascript testing library\n§\npython testing framework");
    const sessionStore = new InMemorySessionStore();
    const graph = await buildMemoryGraph({ memoryStore, sessionStore, maxEdgesPerNode: 4 });
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.edges.every((e) => e.kind === "keyword")).toBe(true);
    expect(graph.edges[0]?.weight).toBeGreaterThan(0);
  });

  it("links sessions to related memory nodes", async () => {
    const memoryStore = new BoundedMemoryStore();
    memoryStore.load("memory", "deployment pipeline for kubernetes");
    const sessionStore = new InMemorySessionStore();
    await sessionStore.createSession(makeProfile(), { title: "kubernetes deployment" });
    const graph = await buildMemoryGraph({ memoryStore, sessionStore, maxEdgesPerNode: 4 });
    const relatedEdges = graph.edges.filter((e) => e.kind === "related");
    expect(relatedEdges.length).toBeGreaterThan(0);
  });

  it("respects maxEdgesPerNode", async () => {
    const memoryStore = new BoundedMemoryStore();
    memoryStore.load("memory", "one two three\n§\none two three\n§\none two three");
    const sessionStore = new InMemorySessionStore();
    const graph = await buildMemoryGraph({ memoryStore, sessionStore, maxEdgesPerNode: 1 });
    const outgoingBySource = new Map<string, number>();
    for (const edge of graph.edges) {
      outgoingBySource.set(edge.source, (outgoingBySource.get(edge.source) ?? 0) + 1);
    }
    for (const count of outgoingBySource.values()) {
      expect(count).toBeLessThanOrEqual(1);
    }
  });
});
