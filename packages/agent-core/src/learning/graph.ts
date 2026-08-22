/**
 * In-memory memory graph builder.
 *
 * Derives nodes from the bounded memory store and session store, and edges
 * from keyword overlap. This is a lightweight, in-process approximation of the
 * Python `learning_graph.py` algorithm used by `/journey` and `/memory-graph`.
 */

import type { BoundedMemoryStore } from "../memory/store.js";
import type { MemoryScope } from "../memory/types.js";
import type { AgentSession, SessionStore } from "../session/store.js";
import type { MemoryGraph, MemoryGraphEdge, MemoryGraphNode } from "./types.js";

export interface MemoryGraphBuilderOptions {
  /** Bounded memory store (read-only). */
  memoryStore: BoundedMemoryStore;
  /** Session store (read-only). */
  sessionStore: SessionStore;
  /** Maximum keyword edges emitted per source node. */
  maxEdgesPerNode?: number;
  /** Minimum keyword overlap score required to emit an edge. */
  minEdgeScore?: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function sharedKeywordScore(a: string[], b: string[]): number {
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t)).length;
  const total = new Set([...a, ...b]).size;
  return total === 0 ? 0 : shared / total;
}

interface ScoredEdge {
  target: string;
  score: number;
}

function topEdges(
  sourceId: string,
  candidates: ScoredEdge[],
  kind: MemoryGraphEdge["kind"],
  maxEdges: number,
): MemoryGraphEdge[] {
  const sorted = candidates.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  return sorted.slice(0, maxEdges).map((c) => ({
    source: sourceId,
    target: c.target,
    kind,
    weight: Number(c.score.toFixed(4)),
  }));
}

/**
 * Build an in-memory memory graph from memory entries and sessions.
 */
export async function buildMemoryGraph(opts: MemoryGraphBuilderOptions): Promise<MemoryGraph> {
  const maxEdges = Math.max(0, opts.maxEdgesPerNode ?? 4);
  const minScore = opts.minEdgeScore ?? 0;
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];

  const memoryNodes: MemoryGraphNode[] = [];
  const memoryTokens: string[][] = [];

  for (const scope of ["memory", "user"] as MemoryScope[]) {
    const entries = opts.memoryStore.getEntries(scope);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const id = `memory:${scope}:${i}`;
      const label = entry.content.slice(0, 60).replace(/\s+/g, " ").trim();
      memoryNodes.push({
        id,
        kind: "memory",
        label: label || id,
        source: scope,
        metadata: { importance: entry.importance, fullLength: entry.content.length },
      });
      memoryTokens.push(tokenize(entry.content));
    }
  }
  nodes.push(...memoryNodes);

  let sessions: AgentSession[] = [];
  try {
    sessions = await opts.sessionStore.listSessions();
  } catch {
    sessions = [];
  }

  for (const session of sessions) {
    nodes.push({
      id: `session:${session.id}`,
      kind: "session",
      label: session.title,
      timestamp: session.startedAt,
      source: session.source ?? "unknown",
      metadata: {
        messageCount: session.messageCount,
        toolCallCount: session.toolCallCount,
      },
    });
  }

  // Keyword edges among memory nodes.
  for (let i = 0; i < memoryNodes.length; i++) {
    const sourceNode = memoryNodes[i];
    if (!sourceNode) continue;
    const candidates: ScoredEdge[] = [];
    for (let j = 0; j < memoryNodes.length; j++) {
      if (i === j) continue;
      const targetNode = memoryNodes[j];
      if (!targetNode) continue;
      const score = sharedKeywordScore(memoryTokens[i] ?? [], memoryTokens[j] ?? []);
      if (score >= minScore) {
        candidates.push({ target: targetNode.id, score });
      }
    }
    edges.push(...topEdges(sourceNode.id, candidates, "keyword", maxEdges));
  }

  // Session -> memory edges by keyword overlap.
  for (const session of sessions) {
    const sessionId = `session:${session.id}`;
    const sessionText = `${session.title} ${session.preview ?? ""}`;
    const sessionTokens = tokenize(sessionText);
    const candidates: ScoredEdge[] = [];
    for (let i = 0; i < memoryNodes.length; i++) {
      const memoryNode = memoryNodes[i];
      if (!memoryNode) continue;
      const score = sharedKeywordScore(sessionTokens, memoryTokens[i] ?? []);
      if (score >= minScore) {
        candidates.push({ target: memoryNode.id, score });
      }
    }
    edges.push(...topEdges(sessionId, candidates, "related", maxEdges));
  }

  const stats = {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    topicCount: 0,
    memoryCount: memoryNodes.length,
    sessionCount: sessions.length,
  };

  return { nodes, edges, stats };
}
