/**
 * Local `/journey` `/learning` `/memory-graph` slash-command handlers.
 *
 * Mirrors the Python `hermes_cli/journey.py` text surface:
 *   /journey               — show learning journey summary
 *   /journey graph         — show memory graph and open panel
 *   /learning <topic-name> — create a new learning topic
 *   /memory-graph          — show memory graph summary and open panel
 */

import type { LearningJourney, LearningTopic, MemoryGraph } from "@hermes/agent-core";
import type { CommandResult } from "../types";

export interface LearningHandlerContext {
  /** The in-process learning journey service. */
  journey: LearningJourney;
  /** Build the in-memory memory graph from sessions + memories. */
  buildGraph: () => Promise<MemoryGraph>;
  /** Optional navigation callback to open the journey panel. */
  navigate?: (to: string) => void;
}

function ok(output: string, extras?: Partial<CommandResult>): CommandResult {
  return { type: "exec", output, ...extras };
}

function err(message: string): CommandResult {
  return { type: "error", message };
}

function formatTopic(topic: LearningTopic): string {
  const due = topic.nextReviewAt ? new Date(topic.nextReviewAt).toLocaleDateString() : "not scheduled";
  return `- ${topic.name} (recalls: ${topic.recallCount}, due: ${due})`;
}

/**
 * `/journey [graph]` — show the learning journey summary or the memory graph.
 */
export async function handleJourney(args: string, ctx: LearningHandlerContext): Promise<CommandResult> {
  const sub = args.trim().toLowerCase();
  if (sub === "graph" || sub === "memory-graph") {
    ctx.navigate?.("journey");
    const graph = await ctx.buildGraph();
    return ok(
      [
        "Memory graph",
        `  ${graph.stats.nodeCount} nodes`,
        `  ${graph.stats.edgeCount} edges`,
        `  ${graph.stats.memoryCount} memory entries`,
        `  ${graph.stats.sessionCount} sessions`,
      ].join("\n"),
    );
  }

  const snapshot = ctx.journey.snapshot();
  if (snapshot.topics.length === 0) {
    return ok("No learning yet — keep using Hermes and it maps out here.");
  }

  const lines = ["Learning Journey", ""];
  lines.push(`Topics: ${snapshot.topics.length}`);
  lines.push(`Due for review: ${snapshot.dueTopics.length}`);
  lines.push("");
  lines.push("Due reviews:");
  lines.push(...snapshot.dueTopics.slice(0, 10).map(formatTopic));
  if (snapshot.dueTopics.length > 10) {
    lines.push(`... and ${snapshot.dueTopics.length - 10} more`);
  }
  return ok(lines.join("\n"));
}

/**
 * `/learning [topic-name]` — alias for `/journey`, or creates a new topic when a name is given.
 */
export async function handleLearning(args: string, ctx: LearningHandlerContext): Promise<CommandResult> {
  const name = args.trim();
  if (!name) {
    return handleJourney(args, ctx);
  }
  const topic = ctx.journey.addTopic(name);
  return ok(`Created learning topic: ${topic.name} (${topic.id}).`);
}

/**
 * `/memory-graph` — show the memory graph summary and open the panel.
 */
export async function handleMemoryGraph(args: string, ctx: LearningHandlerContext): Promise<CommandResult> {
  ctx.navigate?.("journey");
  const graph = await ctx.buildGraph();
  const lines = ["Memory Graph", "", `Nodes: ${graph.stats.nodeCount}`, `Edges: ${graph.stats.edgeCount}`, ""];
  const topNodes = graph.nodes.slice(0, 12).map((n) => `- [${n.kind}] ${n.label}`);
  lines.push(...topNodes);
  if (graph.nodes.length > 12) {
    lines.push(`... and ${graph.nodes.length - 12} more nodes`);
  }
  return ok(lines.join("\n"));
}
