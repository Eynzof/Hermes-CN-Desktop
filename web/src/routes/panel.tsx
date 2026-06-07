import { useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { activeSessionIdAtom } from "@/stores/ui";
import { useSessions } from "@/hooks/use-sessions";
import { isSessionRunning, mergeLiveRuntimeSessions } from "@/lib/session-activity";
import {
  readSessionTitleOverrides,
  subscribeSessionUiStateChanges,
} from "@/lib/session-ui-state";
import { HealthGrid } from "@/components/panel/health-grid";
import { PanelComposer } from "@/components/panel/panel-composer";
import { PanelHero } from "@/components/panel/panel-hero";
import { QuickStart } from "@/components/panel/quick-start";
import { RecentTable } from "@/components/panel/recent-table";
import { TaskCard } from "@/components/panel/task-card";
import type { SessionSummary } from "@hermes/protocol";
import s from "./panel.module.css";

const TODAY_START_SEC = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
};

interface SectionProps {
  num: string;
  tag: string;
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ num, tag, title, meta, children }: SectionProps) {
  return (
    <section className={s.section}>
      <div className={s.sectionNum}>§ {num}</div>
      <div className={s.sectionBody}>
        <div className={s.sectionHead}>
          <div className={s.sectionLh}>
            <span className={s.sectionTag}>[ {tag} ]</span>
            <h2 className={s.sectionTitle}>{title}</h2>
          </div>
          {meta && <div className={s.sectionMeta}>{meta}</div>}
        </div>
        {children}
      </div>
    </section>
  );
}

export function PanelRoute() {
  const [, setActiveId] = useAtom(activeSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const { data, isLoading } = useSessions();
  const navigate = useNavigate();
  const [sessionTitleOverrides, setSessionTitleOverrides] = useState(readSessionTitleOverrides);

  useEffect(() => {
    return subscribeSessionUiStateChanges(() => {
      setSessionTitleOverrides(readSessionTitleOverrides());
    });
  }, []);

  const sessions = useMemo(
    () =>
      mergeLiveRuntimeSessions(
        (data?.sessions ?? []).flatMap((session) => {
          const title = sessionTitleOverrides[session.id];
          return title ? [{ ...session, title }] : [session];
        }),
        runtimeBySession,
      ),
    [data?.sessions, runtimeBySession, sessionTitleOverrides],
  );

  const { active, recent } = useMemo(() => {
    const active = sessions.filter((session) => isSessionRunning(session, runtimeBySession));
    const recent = sessions.filter((session) => !isSessionRunning(session, runtimeBySession));
    return { active, recent };
  }, [runtimeBySession, sessions]);

  const todayStats = useMemo(() => {
    const start = TODAY_START_SEC();
    let completed = 0;
    let needsAttention = 0;
    for (const sess of sessions) {
      if (sess.ended_at != null && sess.ended_at >= start) {
        if (sess.end_reason === "error" || sess.end_reason === "interrupted") {
          needsAttention += 1;
        } else {
          completed += 1;
        }
      }
    }
    return { completed, needsAttention };
  }, [sessions]);

  const goSession = (sess: SessionSummary) => {
    setActiveId(sess.id);
    navigate(`/tasks/${sess.id}`);
  };

  return (
    <div className={s.pageWrap}>
      <div className={s.pageContent}>
        <PanelHero
          activeCount={active.length}
          completedToday={todayStats.completed}
          needsAttention={todayStats.needsAttention}
        />

        <Section num="01" tag="开始" title="新任务">
          <PanelComposer />
        </Section>

        <Section
          num="02"
          tag="健康"
          title="当前状态"
          meta={<>实时刷新</>}
        >
          <HealthGrid />
        </Section>

        {isLoading && <div className={s.loading}>加载中…</div>}

        {active.length > 0 && (
          <Section
            num="03"
            tag="运行中"
            title="正在执行"
            meta={`${active.length} 个任务 · 自动刷新`}
          >
            <div className={s.taskGrid}>
              {active.map((sess) => (
                <TaskCard key={sess.id} session={sess} onClick={() => goSession(sess)} />
              ))}
            </div>
          </Section>
        )}

        <Section
          num={active.length > 0 ? "04" : "03"}
          tag="近况"
          title="最近会话"
          meta={`共 ${recent.length} 个`}
        >
          <RecentTable sessions={recent} onOpen={goSession} />
        </Section>

        <Section
          num={active.length > 0 ? "05" : "04"}
          tag="模板"
          title="快速起手"
          meta="点击预填到 Composer"
        >
          <QuickStart />
        </Section>
      </div>
    </div>
  );
}
