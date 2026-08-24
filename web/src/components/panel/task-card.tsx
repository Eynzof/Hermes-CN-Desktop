import { useAtomValue } from "jotai";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { findRuntimeForSession } from "@/lib/session-activity";
import { sessionDisplayTitle } from "@/lib/session-title";
import { formatTokens, relativeTime } from "@/lib/format";
import { Dot, Pill } from "@/components/ui/pill";
import type { SessionSummary } from "@hermes/protocol";
import s from "./task-card.module.css";

function shortId(id: string): string {
  return id.slice(-6);
}

interface TaskCardProps {
  session: SessionSummary;
  onClick: () => void;
}

export function TaskCard({ session, onClick }: TaskCardProps) {
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  // 运行时会话可能用 gateway id 做 key，而列表里的 session.id 是 persistent
  // id（见 mergeLiveRuntimeSessions）。直接按下标取会漏掉待审批数，必须走
  // 与 isSessionRunning 一致的别名解析。
  const runtime = findRuntimeForSession(session.id, runtimeBySession);
  const pendingCount = runtime?.pendingApprovals.length ?? 0;

  const toolCount = session.tool_call_count ?? 0;
  const tokens = (session.input_tokens ?? 0) + (session.output_tokens ?? 0);
  const desc = session.preview?.trim() || "尚未输出内容…";

  return (
    <button className={s.card} type="button" onClick={onClick}>
      <div className={s.head}>
        <span className={s.headId}>{shortId(session.id)}</span>
        <span className={s.headSep}>·</span>
        <span>{session.model || "—"}</span>
        <span className={s.headSep}>·</span>
        <span>{relativeTime(session.started_at)} 启动</span>
        <span className={s.headSpacer} />
        <Pill tone="ok">
          <Dot tone="live" />
          运行中
        </Pill>
      </div>

      <div className={s.title}>{sessionDisplayTitle(session)}</div>
      <div className={s.desc}>{desc}</div>

      <div className={s.foot}>
        <span>
          {toolCount} 工具
          {pendingCount > 0 && (
            <>
              {" · "}
              <span className={s.footAttn}>{pendingCount} 待审批</span>
            </>
          )}
        </span>
        {tokens > 0 && (
          <>
            <span className={s.footSep}>|</span>
            <span>{formatTokens(tokens)} tokens</span>
          </>
        )}
        <span className={s.footEnter}>→ 进入工作台</span>
      </div>
    </button>
  );
}
