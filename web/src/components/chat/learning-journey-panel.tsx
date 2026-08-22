import { useMemo, useState } from "react";
import { clsx } from "clsx";
import type { LearningJourneySnapshot, MemoryGraph } from "@hermes/agent-core";
import s from "./learning-journey-panel.module.css";

interface LearningJourneyPanelProps {
  snapshot: LearningJourneySnapshot | null;
  graph: MemoryGraph | null;
  className?: string;
}

function formatDate(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString();
}

export function LearningJourneyPanel({ snapshot, graph, className }: LearningJourneyPanelProps) {
  const [tab, setTab] = useState<"journey" | "graph">("journey");

  const dueCount = snapshot?.dueTopics.length ?? 0;
  const hasData = Boolean(snapshot) || Boolean(graph);

  const graphEdgesByNode = useMemo(() => {
    if (!graph) return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const edge of graph.edges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    }
    return counts;
  }, [graph]);

  if (!hasData) {
    return (
      <div className={clsx(s.panel, className)}>
        <p className={s.empty}>No learning journey data available.</p>
      </div>
    );
  }

  return (
    <div className={clsx(s.panel, className)} data-testid="learning-journey-panel">
      <div className={s.header}>
        <span className={s.title}>Learning Journey</span>
        {dueCount > 0 ? <span className={s.badge}>{dueCount} due</span> : null}
      </div>
      <div className={s.tabs} role="tablist">
        <button
          type="button"
          className={clsx(s.tab, tab === "journey" && s.active)}
          onClick={() => setTab("journey")}
          role="tab"
          aria-selected={tab === "journey"}
        >
          Journey
        </button>
        <button
          type="button"
          className={clsx(s.tab, tab === "graph" && s.active)}
          onClick={() => setTab("graph")}
          role="tab"
          aria-selected={tab === "graph"}
        >
          Memory Graph
        </button>
      </div>

      {tab === "journey" && (
        <div className={s.tabPanel} role="tabpanel">
          {snapshot && snapshot.topics.length > 0 ? (
            <ul className={s.list}>
              {snapshot.topics.map((topic) => (
                <li key={topic.id} className={s.item}>
                  <div className={s.itemTitle}>{topic.name}</div>
                  {topic.description ? <div className={s.itemDesc}>{topic.description}</div> : null}
                  <div className={s.itemMeta}>
                    {topic.recallCount} recall{topic.recallCount === 1 ? "" : "s"}
                    {" · "}
                    {topic.nextReviewAt ? `due ${formatDate(topic.nextReviewAt)}` : "not scheduled"}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.empty}>No learning yet — keep using Hermes and it maps out here.</p>
          )}
        </div>
      )}

      {tab === "graph" && (
        <div className={s.tabPanel} role="tabpanel">
          {graph ? (
            <div className={s.graphSummary}>
            <div className={s.stats}>
              <span>Nodes: {graph.stats.nodeCount}</span>
              <span>Edges: {graph.stats.edgeCount}</span>
              <span>Memory: {graph.stats.memoryCount}</span>
              <span>Sessions: {graph.stats.sessionCount}</span>
            </div>
              <ul className={s.nodeList}>
                {graph.nodes.slice(0, 20).map((node) => (
                  <li key={node.id} className={clsx(s.node, s[node.kind])}>
                    <span className={s.nodeKind}>{node.kind}</span>
                    <span className={s.nodeLabel} title={node.label}>
                      {node.label}
                    </span>
                    {graphEdgesByNode.has(node.id) ? (
                      <span className={s.nodeEdges}>{graphEdgesByNode.get(node.id)} edges</span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {graph.nodes.length > 20 ? (
                <p className={s.more}>... and {graph.nodes.length - 20} more nodes</p>
              ) : null}
            </div>
          ) : (
            <p className={s.empty}>No memory graph data available.</p>
          )}
        </div>
      )}
    </div>
  );
}
