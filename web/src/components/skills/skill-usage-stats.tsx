import { useMemo, useState } from "react";
import { BarChart3, Clock3, RefreshCw, Sparkles, Wrench } from "lucide-react";
import type { AnalyticsResponse } from "@hermes/protocol";
import { useAnalytics } from "@/hooks/use-analytics";
import { relativeTime } from "@/lib/format";
import { skillTranslations } from "@/lib/skill-translations";
import s from "./skill-usage-stats.module.css";

const PERIODS = [
  { days: 7, label: "7 天" },
  { days: 30, label: "30 天" },
  { days: 90, label: "90 天" },
] as const;

type SkillUsageEntry = AnalyticsResponse["skills"]["top_skills"][number];

export interface SkillUsageRow extends SkillUsageEntry {
  displayName: string;
  invocationShare: number;
}

export function buildSkillUsageRows(
  entries: SkillUsageEntry[],
  totalInvocations: number,
): SkillUsageRow[] {
  return entries
    .map((entry) => ({
      ...entry,
      displayName: skillTranslations[entry.skill]?.displayName ?? entry.skill,
      invocationShare: totalInvocations > 0 ? entry.view_count / totalInvocations : 0,
    }))
    .sort((a, b) =>
      b.view_count - a.view_count
      || b.manage_count - a.manage_count
      || (b.last_used_at ?? 0) - (a.last_used_at ?? 0)
      || a.skill.localeCompare(b.skill),
    );
}

function integer(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

export function SkillUsageStats({ profileOverride }: { profileOverride?: string | null }) {
  const [days, setDays] = useState(30);
  const query = useAnalytics(days, profileOverride);
  const skills = query.data?.skills;
  const rows = useMemo(
    () => buildSkillUsageRows(skills?.top_skills ?? [], skills?.summary.total_skill_loads ?? 0),
    [skills],
  );
  const invokedSkills = rows.filter((row) => row.view_count > 0).length;
  const maxInvocations = Math.max(...rows.map((row) => row.view_count), 1);
  const leader = rows.find((row) => row.view_count > 0) ?? null;

  return (
    <section className={s.page} aria-label="Skill 调用统计">
      <header className={s.hero}>
        <div>
          <span className={s.eyebrow}>Usage Analytics</span>
          <h2>Skill 调用统计</h2>
          <p>
            调用次数按 Core 完成的 Skill 加载统计；编辑操作单独计数，不会混入调用量。
          </p>
        </div>
        <div className={s.toolbar}>
          <div className={s.periods} role="group" aria-label="统计周期">
            {PERIODS.map((period) => (
              <button
                key={period.days}
                type="button"
                data-active={days === period.days ? "true" : undefined}
                aria-pressed={days === period.days}
                onClick={() => setDays(period.days)}
              >
                {period.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={s.refreshButton}
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw size={13} />
            {query.isFetching ? "刷新中" : "刷新"}
          </button>
        </div>
      </header>

      {query.isLoading ? (
        <div className={s.stateCard} aria-live="polite">
          <BarChart3 size={22} />
          <div>
            <strong>正在读取调用统计</strong>
            <p>正在从当前 Hermes 档案聚合 Skill 使用记录。</p>
          </div>
        </div>
      ) : query.isError ? (
        <div className={s.stateCard} data-tone="error" role="alert">
          <BarChart3 size={22} />
          <div>
            <strong>无法加载 Skill 统计</strong>
            <p>{query.error instanceof Error ? query.error.message : "请求失败，请稍后重试。"}</p>
          </div>
        </div>
      ) : skills ? (
        <>
          <div className={s.kpiGrid} data-testid="skill-usage-summary">
            <article className={s.kpiCard} data-accent="true">
              <div className={s.kpiIcon}><BarChart3 size={16} /></div>
              <div>
                <span>调用总数</span>
                <strong>{integer(skills.summary.total_skill_loads)}</strong>
                <small>最近 {query.data?.period_days ?? days} 天</small>
              </div>
            </article>
            <article className={s.kpiCard}>
              <div className={s.kpiIcon}><Sparkles size={16} /></div>
              <div>
                <span>已调用 Skill</span>
                <strong>{integer(invokedSkills)}</strong>
                <small>有过至少一次加载</small>
              </div>
            </article>
            <article className={s.kpiCard}>
              <div className={s.kpiIcon}><Clock3 size={16} /></div>
              <div className={s.leaderMetric}>
                <span>最常调用</span>
                <strong title={leader?.skill}>{leader?.displayName ?? "—"}</strong>
                <small>{leader ? `${integer(leader.view_count)} 次调用` : "暂无调用"}</small>
              </div>
            </article>
            <article className={s.kpiCard}>
              <div className={s.kpiIcon}><Wrench size={16} /></div>
              <div>
                <span>编辑操作</span>
                <strong>{integer(skills.summary.total_skill_edits)}</strong>
                <small>Skill 新建、更新与管理</small>
              </div>
            </article>
          </div>

          <section className={s.rankingPanel}>
            <div className={s.panelHead}>
              <div>
                <h3>调用排行</h3>
                <p>按调用次数排序，进度条表示该周期内的调用占比。</p>
              </div>
              <span>{integer(skills.summary.total_skill_actions)} 次总操作</span>
            </div>

            {rows.length === 0 ? (
              <div className={s.emptyState}>
                <BarChart3 size={25} />
                <strong>这个时间范围内还没有 Skill 调用</strong>
                <p>Hermes 在对话中加载 Skill 后，统计会自动出现在这里。</p>
              </div>
            ) : (
              <div className={s.ranking} role="table" aria-label="Skill 调用排行">
                <div className={s.rankingHead} role="row">
                  <span role="columnheader">Skill</span>
                  <span role="columnheader">调用分布</span>
                  <span role="columnheader">调用</span>
                  <span role="columnheader">编辑</span>
                  <span role="columnheader">最近活动</span>
                </div>
                {rows.map((row, index) => (
                  <div className={s.rankingRow} role="row" key={row.skill}>
                    <div className={s.skillName} role="cell">
                      <span className={s.rank}>{String(index + 1).padStart(2, "0")}</span>
                      <span>
                        <strong>{row.displayName}</strong>
                        <small>{row.skill}</small>
                      </span>
                    </div>
                    <div className={s.distribution} role="cell">
                      <span className={s.barTrack}>
                        <span
                          className={s.barFill}
                          style={{ width: `${(row.view_count / maxInvocations) * 100}%` }}
                        />
                      </span>
                      <small>{percent(row.invocationShare)}</small>
                    </div>
                    <strong className={s.count} role="cell">{integer(row.view_count)}</strong>
                    <span className={s.editCount} role="cell">{integer(row.manage_count)}</span>
                    <span className={s.lastUsed} role="cell">
                      {row.last_used_at ? relativeTime(row.last_used_at) : "—"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </section>
  );
}
