import { useAtomValue } from "jotai";
import { ExternalLink } from "lucide-react";
import { flattenSubagents, subagentsBySessionAtom, buildSubagentTree } from "@/stores/subagents";
import { SectionShell } from "./section-shell";
import s from "./agents.module.css";

function fmtMoney(value?: number): string {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "$0";
}

export function AgentsRoute() {
  const bySession = useAtomValue(subagentsBySessionAtom);
  const entries = Object.entries(bySession).filter(([, list]) => list.length > 0);
  const total = entries.reduce((sum, [, list]) => sum + list.length, 0);

  const openSession = async (sessionId: string) => {
    await window.hermesDesktop?.openSessionWindow?.(sessionId, { watch: true });
  };

  return (
    <SectionShell title="Agents" sub={`子代理派生树 / ${total} 个节点`}>
      <div className={s.wrap}>
        {entries.length === 0 ? (
          <div>当前还没有子代理活动。</div>
        ) : (
          entries.map(([sessionId, list]) => {
            const rows = flattenSubagents(buildSubagentTree(list));
            return (
              <section className={s.session} key={sessionId}>
                <div className={s.sessionHead}>
                  <span>{sessionId}</span>
                  <span>{rows.length} agents</span>
                </div>
                <div className={s.list}>
                  {rows.map((agent) => (
                    <div className={s.row} key={agent.id}>
                      <div style={{ paddingLeft: `${agent.parentId ? 22 : 0}px` }}>
                        <div className={s.goal}>{agent.goal}</div>
                        <div className={s.meta}>
                          {agent.model ?? "model"} / tools {agent.toolCount ?? 0} / tokens {(agent.inputTokens ?? 0) + (agent.outputTokens ?? 0)} / {fmtMoney(agent.costUsd)}
                        </div>
                        <div className={s.meta}>
                          read {agent.filesRead.length} / wrote {agent.filesWritten.length}
                          {agent.durationSeconds ? ` / ${agent.durationSeconds.toFixed(1)}s` : ""}
                        </div>
                        {agent.stream.at(-1) ? <div className={s.stream}>{agent.stream.at(-1)!.text}</div> : null}
                      </div>
                      <div>
                        <div className={s.status}>{agent.status}</div>
                        {agent.sessionId ? (
                          <button className={s.btn} type="button" onClick={() => void openSession(agent.sessionId!)}>
                            <ExternalLink size={14} /> 旁观
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </SectionShell>
  );
}
