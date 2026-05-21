import { useEffect, useState } from "react";
import { formatHeroTimestamp } from "@/lib/format";
import s from "./panel-hero.module.css";

interface PanelHeroProps {
  activeCount: number;
  completedToday: number;
  needsAttention: number;
}

function greetingParts(hour: number): { lead: string; body: string } {
  if (hour < 6) return { lead: "夜深了，", body: "休息一下？" };
  if (hour < 12) return { lead: "早上好，", body: "开始今天的工作" };
  if (hour < 18) return { lead: "下午好，", body: "我们该做什么？" };
  return { lead: "晚上好，", body: "给今天收收尾？" };
}

export function PanelHero({ activeCount, completedToday, needsAttention }: PanelHeroProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const { lead, body } = greetingParts(now.getHours());

  return (
    <div className={s.hero}>
      <div className={s.num}>
        <span className={s.numTop}>NO. 001</span>
        <span>工作台</span>
      </div>
      <div className={s.body}>
        <h1 className={s.title}>
          {lead}
          <br />
          <em>{body}</em>
        </h1>
        <div className={s.greet}>
          <span className={s.day}>{formatHeroTimestamp(now)}</span>
          <span>
            {activeCount} 个任务进行中，{completedToday} 个今日完成
            {needsAttention > 0 && <>，<span className={s.attn}>{needsAttention} 个需要关注</span></>}
            。
          </span>
        </div>
      </div>
    </div>
  );
}
