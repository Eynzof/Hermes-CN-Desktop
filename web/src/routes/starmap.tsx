import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StarmapGraph, StarmapNode } from "@hermes/protocol";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  decodeStarmapShareCode,
  deleteStarmapNode,
  encodeStarmapShareCode,
  fetchStarmapGraph,
  fetchStarmapNode,
  updateStarmapNode,
} from "@/lib/starmap";
import { SectionShell } from "./section-shell";
import s from "./starmap.module.css";

type Filter = "all" | "used" | "learned";

function visibleNodes(graph: StarmapGraph, filter: Filter): StarmapNode[] {
  if (filter === "all") return graph.nodes;
  if (filter === "used") return graph.nodes.filter((n) => (n.useCount ?? 0) > 0 || n.kind === "memory");
  return graph.nodes.filter((n) => n.kind === "memory" || n.createdBy === "agent" || (n.useCount ?? 0) > 0);
}

function layout(nodes: readonly StarmapNode[]) {
  const cx = 500;
  const cy = 330;
  const radius = 230;
  return new Map(
    nodes.map((node, index) => {
      const t = nodes.length <= 1 ? 0 : index / nodes.length;
      const ring = node.kind === "memory" ? radius * 0.58 : radius;
      const angle = t * Math.PI * 2 - Math.PI / 2;
      return [node.id, { x: cx + Math.cos(angle) * ring, y: cy + Math.sin(angle) * ring }];
    }),
  );
}

export function StarmapRoute() {
  const profile = useActiveProfileName();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [share, setShare] = useState("");
  const [imported, setImported] = useState<StarmapGraph | null>(null);
  const [selected, setSelected] = useState<StarmapNode | null>(null);
  const [content, setContent] = useState("");

  const graphQuery = useQuery({
    queryKey: ["starmap", profile],
    queryFn: ({ signal }) => fetchStarmapGraph(profile, signal),
  });

  const graph = imported ?? graphQuery.data;
  const nodes = useMemo(() => (graph ? visibleNodes(graph, filter) : []), [filter, graph]);
  const pos = useMemo(() => layout(nodes), [nodes]);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = (graph?.edges ?? []).filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  const saveMutation = useMutation({
    mutationFn: () => updateStarmapNode(selected!.id, content, profile),
    onSuccess: () => {
      setImported(null);
      void qc.invalidateQueries({ queryKey: ["starmap", profile] });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteStarmapNode(selected!.id, profile),
    onSuccess: () => {
      setSelected(null);
      setContent("");
      setImported(null);
      void qc.invalidateQueries({ queryKey: ["starmap", profile] });
    },
  });

  const openNode = async (node: StarmapNode) => {
    setSelected(node);
    setContent("");
    try {
      const detail = await fetchStarmapNode(node.id, profile);
      const body = detail && typeof detail === "object" && "content" in detail
        ? String((detail as { content?: unknown }).content ?? "")
        : "";
      setContent(body);
    } catch {
      setContent("");
    }
  };

  const right = (
    <button className={s.btn} type="button" onClick={() => void graphQuery.refetch()}>
      刷新
    </button>
  );

  return (
    <SectionShell title="记忆图谱" sub="技能、记忆和关系的 starmap" right={right}>
      <div className={s.wrap}>
        <div className={s.toolbar}>
          <div className={s.seg}>
            {(["all", "used", "learned"] as const).map((item) => (
              <button key={item} type="button" data-active={filter === item ? "true" : undefined} onClick={() => setFilter(item)}>
                {item === "all" ? "全部" : item === "used" ? "已使用" : "已学习"}
              </button>
            ))}
          </div>
          <input
            className={s.input}
            value={share}
            onChange={(event) => setShare(event.target.value)}
            placeholder="粘贴或生成图谱布局代码"
          />
          <button
            className={s.btn}
            type="button"
            disabled={!graph}
            onClick={() => graph && setShare(encodeStarmapShareCode(graph))}
          >
            导出
          </button>
          <button
            className={s.btn}
            type="button"
            onClick={() => {
              const decoded = decodeStarmapShareCode(share);
              setImported(decoded);
            }}
          >
            导入
          </button>
        </div>

        <div className={s.map}>
          {graphQuery.isLoading && !graph ? (
            <div className={s.panel}>正在加载图谱...</div>
          ) : !graph || nodes.length === 0 ? (
            <div className={s.panel}>还没有可展示的技能或记忆。</div>
          ) : (
            <svg viewBox="0 0 1000 660" role="img" aria-label="Hermes starmap">
              {edges.map((edge, index) => {
                const a = pos.get(edge.source);
                const b = pos.get(edge.target);
                if (!a || !b) return null;
                return <line key={`${edge.source}-${edge.target}-${index}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" opacity="0.18" />;
              })}
              {nodes.map((node) => {
                const p = pos.get(node.id)!;
                const size = Math.min(22, 8 + Math.sqrt(node.useCount ?? 0) * 3 + (node.pinned ? 4 : 0));
                const active = selected?.id === node.id;
                return (
                  <g key={node.id} className={s.node} onClick={() => void openNode(node)} opacity={active ? 1 : 0.86}>
                    {node.kind === "memory" ? (
                      <rect x={p.x - size} y={p.y - size} width={size * 2} height={size * 2} transform={`rotate(45 ${p.x} ${p.y})`} fill="var(--h-accent)" />
                    ) : (
                      <circle cx={p.x} cy={p.y} r={size} fill={node.createdBy === "agent" ? "var(--h-accent)" : "var(--h-text-muted)"} />
                    )}
                    <text className={s.label} x={p.x + size + 6} y={p.y + 4}>{node.label}</text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {selected ? (
          <section className={s.panel}>
            <h3>{selected.label}</h3>
            <div className={s.muted}>
              {selected.kind} / {selected.category ?? "unknown"} / {selected.id}
            </div>
            <textarea className={s.textarea} value={content} onChange={(event) => setContent(event.target.value)} />
            <div className={s.actions}>
              <button className={s.btn} type="button" disabled={!content || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                保存
              </button>
              <button className={`${s.btn} ${s.danger}`} type="button" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
                删除
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </SectionShell>
  );
}
