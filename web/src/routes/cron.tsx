import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileText,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import type { CronJob, CronRun } from "@hermes/protocol";
import { useActiveProfileName, useProfiles } from "@/hooks/use-profiles";
import {
  cronJobProfile,
  useCreateCronJob,
  useCronAction,
  useCronJobs,
  useCronRunDetail,
  useCronRuns,
  useDeleteCronJob,
} from "@/hooks/use-cron";
import { SectionShell } from "./section-shell";
import s from "./cron.module.css";

type StatusFilter = "all" | "active" | "paused" | "error" | "completed";
type FeedbackTone = "ok" | "info" | "error";

interface Feedback {
  tone: FeedbackTone;
  message: string;
}

// 仅展示桌面端实际可接入的投递渠道（IM 接入当前支持飞书/微信，见
// src/commands/im_onboarding.rs）。后端合法平台列表见
// Hermes-CN-Core cron/scheduler.py 的 _KNOWN_DELIVERY_PLATFORMS。
const DELIVERY_OPTIONS = [
  { value: "local", label: "本地" },
  { value: "feishu", label: "飞书" },
  { value: "weixin", label: "微信" },
  { value: "email", label: "Email" },
];

function deliveryLabel(value: string): string {
  if (!value) return "本地";
  return DELIVERY_OPTIONS.find((item) => item.value === value)?.label ?? value;
}

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "active", label: "活跃" },
  { value: "paused", label: "暂停" },
  { value: "error", label: "异常" },
  { value: "completed", label: "完成" },
];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function titleOf(job: CronJob): string {
  return text(job.name) || text(job.prompt).slice(0, 80) || text(job.script).slice(0, 80) || job.id;
}

function promptPreview(job: CronJob): string {
  return text(job.prompt) || (text(job.script) ? `脚本：${text(job.script)}` : "无任务描述");
}

function scheduleDisplay(job: CronJob): string {
  const schedule = job.schedule;
  if (text(job.schedule_display)) return text(job.schedule_display);
  if (typeof schedule === "string") return text(schedule) || "未设置";
  if (schedule && typeof schedule === "object") {
    return text(schedule.display) || text(schedule.expr) || text(schedule.value) || "未设置";
  }
  return "未设置";
}

function jobState(job: CronJob): string {
  return text(job.state) || (job.enabled ? "scheduled" : "paused");
}

function isPaused(job: CronJob): boolean {
  return !job.enabled || jobState(job) === "paused";
}

function statusLabel(job: CronJob): string {
  const state = jobState(job);
  if (state === "scheduled") return "计划中";
  if (state === "paused") return "暂停";
  if (state === "running") return "执行中";
  if (state === "completed") return "已完成";
  if (state === "error") return "错误";
  return job.enabled ? "启用" : "暂停";
}

function statusTone(job: CronJob): "ok" | "warn" | "err" | "neutral" | "live" {
  const state = jobState(job);
  if (state === "running") return "live";
  if (state === "scheduled") return "ok";
  if (state === "paused") return "warn";
  if (state === "error") return "err";
  return "neutral";
}

function runTone(status: CronRun["status"]): "ok" | "warn" | "err" | "neutral" | "live" {
  if (status === "success") return "ok";
  if (status === "error" || status === "blocked") return "err";
  if (status === "silent") return "warn";
  return "neutral";
}

function runStatusLabel(status: CronRun["status"]): string {
  if (status === "success") return "成功";
  if (status === "error") return "失败";
  if (status === "blocked") return "阻断";
  if (status === "silent") return "静默";
  return "未知";
}

function jobKey(job: CronJob): string {
  return `${cronJobProfile(job)}:${job.id}`;
}

function parseTime(value: string | number | null | undefined): Date | null {
  if (value == null) return null;
  const date = typeof value === "number"
    ? new Date(value < 1_000_000_000_000 ? value * 1000 : value)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value: string | number | null | undefined): string {
  const date = parseTime(value);
  if (!date) return "—";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatFullTime(value: string | number | null | undefined): string {
  const date = parseTime(value);
  if (!date) return "—";
  return date.toLocaleString("zh-CN");
}

function relativeTime(value: string | number | null | undefined): string {
  const date = parseTime(value);
  if (!date) return "—";
  const diffMs = Date.now() - date.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return future ? "即将" : "刚刚";
  if (mins < 60) return future ? `${mins} 分后` : `${mins} 分前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return future ? `${hours} 小时后` : `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return future ? `${days} 天后` : `${days} 天前`;
  const weeks = Math.round(days / 7);
  return future ? `${weeks} 周后` : `${weeks} 周前`;
}

function resultLine(job: CronJob): string {
  const status = text(job.last_status);
  if (!status) return "尚无执行结果";
  if (status === "ok") return "上次执行成功";
  if (status === "error") return `上次执行失败${text(job.last_error) ? `：${text(job.last_error)}` : ""}`;
  return `上次执行：${status}`;
}

function actionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "请求失败");
}

function matchesStatus(job: CronJob, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  const state = jobState(job);
  if (filter === "active") return job.enabled && state !== "paused" && state !== "completed" && state !== "error";
  if (filter === "paused") return isPaused(job);
  if (filter === "error") return state === "error" || text(job.last_status) === "error";
  return state === "completed";
}

function buildRunErrorMessage(error: unknown): string {
  const raw = actionError(error);
  if (raw.includes("HTTP 404") || raw.includes("__hermes_cron_runs")) {
    return "当前环境无法读取本地运行历史。请使用桌面端，或确认 Tauri IPC 已接管本地历史路由。";
  }
  return `加载运行历史失败：${raw}`;
}

export function CronRoute() {
  const jobsQuery = useCronJobs();
  const profilesQuery = useProfiles();
  const activeProfile = useActiveProfileName();
  const createJob = useCreateCronJob();
  const deleteJob = useDeleteCronJob();
  const cronAction = useCronAction();
  const queryClient = useQueryClient();

  const [query, setQuery] = useState("");
  const [profileFilter, setProfileFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedRunFilename, setSelectedRunFilename] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newProfile, setNewProfile] = useState(activeProfile || "default");
  const [newName, setNewName] = useState("");
  const [newSchedule, setNewSchedule] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newDeliver, setNewDeliver] = useState("local");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const refreshTimersRef = useRef<number[]>([]);

  const jobs = jobsQuery.data ?? [];
  const profiles = profilesQuery.data ?? [];

  useEffect(() => {
    if (!newProfile) setNewProfile(activeProfile || "default");
  }, [activeProfile, newProfile]);

  const filteredJobs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const profile = cronJobProfile(job);
      if (profileFilter !== "all" && profile !== profileFilter) return false;
      if (!matchesStatus(job, statusFilter)) return false;
      if (!needle) return true;
      return [titleOf(job), promptPreview(job), scheduleDisplay(job), profile, job.id]
        .join("\n")
        .toLowerCase()
        .includes(needle);
    });
  }, [jobs, profileFilter, query, statusFilter]);

  useEffect(() => {
    if (filteredJobs.length === 0) {
      if (!jobsQuery.isFetching) setSelectedKey(null);
      return;
    }
    if (!selectedKey) {
      setSelectedKey(jobKey(filteredJobs[0]));
      return;
    }
    if (!filteredJobs.some((job) => jobKey(job) === selectedKey) && !jobsQuery.isFetching) {
      setSelectedKey(jobKey(filteredJobs[0]));
    }
  }, [filteredJobs, jobsQuery.isFetching, selectedKey]);

  const selectedJob = useMemo(() => {
    if (!selectedKey) return null;
    return filteredJobs.find((job) => jobKey(job) === selectedKey) ?? null;
  }, [filteredJobs, selectedKey]);

  const runsQuery = useCronRuns(selectedJob, 30);
  const runs = runsQuery.data ?? [];

  useEffect(() => {
    setSelectedRunFilename(null);
  }, [selectedJob?.id, selectedJob ? cronJobProfile(selectedJob) : ""]);

  useEffect(() => {
    if (runs.length === 0) {
      setSelectedRunFilename(null);
      return;
    }
    if (!selectedRunFilename || !runs.some((run) => run.filename === selectedRunFilename)) {
      setSelectedRunFilename(runs[0]?.filename ?? null);
    }
  }, [runs, selectedRunFilename]);

  const selectedRun = useMemo(() => {
    if (!selectedRunFilename) return runs[0] ?? null;
    return runs.find((run) => run.filename === selectedRunFilename) ?? runs[0] ?? null;
  }, [runs, selectedRunFilename]);
  const runDetailQuery = useCronRunDetail(selectedRun);

  const clearQueuedRefreshes = useCallback(() => {
    refreshTimersRef.current.forEach((id) => window.clearTimeout(id));
    refreshTimersRef.current = [];
  }, []);

  const refetchCronData = useCallback(() => {
    void jobsQuery.refetch();
    void runsQuery.refetch();
  }, [jobsQuery, runsQuery]);

  const queueFollowUpRefreshes = useCallback((job: CronJob) => {
    clearQueuedRefreshes();
    const profile = cronJobProfile(job);
    refreshTimersRef.current = [2_000, 8_000, 30_000, 65_000].map((delay) =>
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["cron-jobs"] });
        void queryClient.invalidateQueries({ queryKey: ["cron-runs", profile, job.id] });
        refetchCronData();
      }, delay),
    );
  }, [clearQueuedRefreshes, queryClient, refetchCronData]);

  useEffect(() => clearQueuedRefreshes, [clearQueuedRefreshes]);

  const handleCreate = () => {
    const schedule = newSchedule.trim();
    const prompt = newPrompt.trim();
    if (!schedule || !prompt) {
      setFeedback({ tone: "error", message: "请填写调度表达式和 Prompt。" });
      return;
    }
    createJob.mutate(
      {
        name: newName.trim() || undefined,
        schedule,
        prompt,
        deliver: newDeliver,
        profile: newProfile || "default",
      },
      {
        onSuccess: (job) => {
          setShowCreate(false);
          setNewName("");
          setNewSchedule("");
          setNewPrompt("");
          setNewDeliver("local");
          setProfileFilter("all");
          setSelectedKey(jobKey(job));
          setFeedback({ tone: "ok", message: `已创建定时任务「${titleOf(job)}」。` });
        },
        onError: (err) => setFeedback({ tone: "error", message: `创建定时任务失败：${actionError(err)}` }),
      },
    );
  };

  const handleAction = (job: CronJob, action: "pause" | "resume" | "trigger") => {
    cronAction.mutate(
      { id: job.id, profile: cronJobProfile(job), action },
      {
        onSuccess: (updated) => {
          setSelectedKey(jobKey(updated));
          if (action === "trigger") {
            setFeedback({
              tone: "info",
              message: `已触发「${titleOf(updated)}」，运行历史会在调度 tick 完成后自动刷新。`,
            });
            queueFollowUpRefreshes(updated);
            return;
          }
          setFeedback({ tone: "ok", message: `${action === "pause" ? "已暂停" : "已恢复"}「${titleOf(updated)}」。` });
        },
        onError: (err) => {
          const actionLabel = action === "pause" ? "暂停" : action === "resume" ? "恢复" : "触发";
          setFeedback({ tone: "error", message: `${actionLabel}定时任务失败：${actionError(err)}` });
        },
      },
    );
  };

  const handleDelete = (job: CronJob) => {
    if (!window.confirm(`删除定时任务「${titleOf(job)}」？此操作无法撤销。`)) return;
    deleteJob.mutate(
      { id: job.id, profile: cronJobProfile(job) },
      {
        onSuccess: () => {
          setFeedback({ tone: "ok", message: `已删除定时任务「${titleOf(job)}」。` });
          setSelectedKey(null);
        },
        onError: (err) => setFeedback({ tone: "error", message: `删除定时任务失败：${actionError(err)}` }),
      },
    );
  };

  const headerRight = (
    <div className={s.headerActions}>
      <button type="button" className={s.headerButton} onClick={refetchCronData} disabled={jobsQuery.isFetching || runsQuery.isFetching}>
        <RefreshCw size={13} /> 刷新
      </button>
      <button type="button" className={s.headerPrimary} onClick={() => setShowCreate(true)}>
        <Plus size={13} /> 新建任务
      </button>
    </div>
  );

  const activeCount = jobs.filter((job) => matchesStatus(job, "active")).length;
  const errorCount = jobs.filter((job) => matchesStatus(job, "error")).length;

  return (
    <SectionShell title="定时任务" sub={`${jobs.length} 个任务 · ${activeCount} 个活跃${errorCount ? ` · ${errorCount} 个异常` : ""}`} right={headerRight}>
      <div className={s.pageGrid}>
        <aside className={s.listPane} aria-label="定时任务列表">
          <div className={s.searchBox}>
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、Prompt、Profile…" />
          </div>
          <div className={s.filters}>
            <select value={profileFilter} onChange={(event) => setProfileFilter(event.target.value)} aria-label="Profile 筛选">
              <option value="all">全部 Profile</option>
              {profiles.map((profile) => (
                <option key={profile.name} value={profile.name}>{profile.name === "default" ? "default" : profile.name}</option>
              ))}
            </select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} aria-label="状态筛选">
              {STATUS_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>

          {jobsQuery.isLoading ? <div className={s.empty}>正在加载定时任务…</div> : null}
          {jobsQuery.isError ? (
            <div className={s.errorState}>加载定时任务失败：{actionError(jobsQuery.error)}</div>
          ) : null}
          {!jobsQuery.isLoading && !jobsQuery.isError && filteredJobs.length === 0 ? (
            <div className={s.empty}>没有匹配的定时任务。</div>
          ) : null}

          <div className={s.jobList}>
            {filteredJobs.map((job) => {
              const selected = selectedJob ? jobKey(job) === jobKey(selectedJob) : false;
              return (
                <button
                  key={jobKey(job)}
                  type="button"
                  className={s.jobRow}
                  data-selected={selected ? "true" : undefined}
                  onClick={() => setSelectedKey(jobKey(job))}
                >
                  <span className={s.jobRowTop}>
                    <span className={s.jobTitle}>{titleOf(job)}</span>
                    <span className={s.dot} data-tone={statusTone(job)} />
                  </span>
                  <span className={s.jobMeta}>{scheduleDisplay(job)}</span>
                  <span className={s.jobMeta}>{cronJobProfile(job)} · 上次 {relativeTime(job.last_run_at ?? job.last_run)}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className={s.detailPane} aria-label="定时任务详情">
          {feedback ? <div className={s.feedback} data-tone={feedback.tone}>{feedback.message}</div> : null}

          {showCreate ? (
            <CreateJobPanel
              profiles={profiles.map((profile) => profile.name)}
              activeProfile={activeProfile || "default"}
              profile={newProfile}
              name={newName}
              schedule={newSchedule}
              prompt={newPrompt}
              deliver={newDeliver}
              creating={createJob.isPending}
              onProfile={setNewProfile}
              onName={setNewName}
              onSchedule={setNewSchedule}
              onPrompt={setNewPrompt}
              onDeliver={setNewDeliver}
              onCancel={() => setShowCreate(false)}
              onSubmit={handleCreate}
            />
          ) : selectedJob ? (
            <JobDetail
              job={selectedJob}
              busy={cronAction.isPending || deleteJob.isPending}
              onPauseResume={() => handleAction(selectedJob, isPaused(selectedJob) ? "resume" : "pause")}
              onTrigger={() => handleAction(selectedJob, "trigger")}
              onDelete={() => handleDelete(selectedJob)}
            />
          ) : (
            <div className={s.detailEmpty}>
              <CalendarClock size={28} />
              <h2>选择或创建一个定时任务</h2>
              <p>这里会展示任务配置、Prompt 和最近执行状态。</p>
              <button type="button" className={s.primaryButton} onClick={() => setShowCreate(true)}>新建任务</button>
            </div>
          )}
        </main>

        <aside className={s.historyPane} aria-label="运行历史记录">
          <div className={s.panelHeader}>
            <div>
              <div className={s.panelTitle}>运行历史记录</div>
              <div className={s.panelSub}>{selectedJob ? `${titleOf(selectedJob).slice(0, 28)} · 最近 30 次` : "选择任务后查看"}</div>
            </div>
            <Clock size={16} />
          </div>

          {!selectedJob ? <div className={s.empty}>尚未选择任务。</div> : null}
          {selectedJob && runsQuery.isLoading ? <div className={s.empty}>正在加载运行历史…</div> : null}
          {selectedJob && runsQuery.isError ? (
            <div className={s.errorState}>{buildRunErrorMessage(runsQuery.error)}</div>
          ) : null}
          {selectedJob && !runsQuery.isLoading && !runsQuery.isError && runs.length === 0 ? (
            <div className={s.empty}>尚无运行记录。立即运行一次后，记录会出现在这里。</div>
          ) : null}

          <div className={s.runList}>
            {runs.map((run) => (
              <button
                key={run.filename}
                type="button"
                className={s.runRow}
                data-selected={selectedRun?.filename === run.filename ? "true" : undefined}
                onClick={() => setSelectedRunFilename(run.filename)}
              >
                <span className={s.runDot} data-tone={runTone(run.status)} />
                <span className={s.runMain}>
                  <span className={s.runTitle}>{runStatusLabel(run.status)} · {run.summary}</span>
                  <span className={s.runMeta}>{formatFullTime(run.started_at)} · {Math.ceil(run.size_bytes / 1024)} KB</span>
                </span>
                <span className={s.runAgo}>{relativeTime(run.started_at)}</span>
              </button>
            ))}
          </div>

          {selectedRun ? (
            <div className={s.runDetailBox}>
              <div className={s.runDetailHeader}>
                <span><FileText size={13} /> 输出详情</span>
                <span>{runStatusLabel(selectedRun.status)}</span>
              </div>
              {runDetailQuery.isLoading ? <div className={s.empty}>正在读取输出…</div> : null}
              {runDetailQuery.isError ? <div className={s.errorState}>读取输出失败：{actionError(runDetailQuery.error)}</div> : null}
              {runDetailQuery.data ? (
                <>
                  {runDetailQuery.data.truncated ? <div className={s.truncated}>输出超过 2 MiB，已截断展示。</div> : null}
                  <pre className={s.outputPre}>{runDetailQuery.data.content || "（无输出内容）"}</pre>
                </>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>
    </SectionShell>
  );
}

interface CreateJobPanelProps {
  profiles: string[];
  activeProfile: string;
  profile: string;
  name: string;
  schedule: string;
  prompt: string;
  deliver: string;
  creating: boolean;
  onProfile: (value: string) => void;
  onName: (value: string) => void;
  onSchedule: (value: string) => void;
  onPrompt: (value: string) => void;
  onDeliver: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function CreateJobPanel(props: CreateJobPanelProps) {
  const profileOptions = props.profiles.length > 0 ? props.profiles : [props.activeProfile || "default"];
  return (
    <section className={s.card}>
      <div className={s.cardHeader}>
        <div>
          <h1>新建定时任务</h1>
          <p>保持任务指令自包含；系统会按计划唤起 Agent 执行。</p>
        </div>
      </div>
      <div className={s.formGrid}>
        <label className={s.field}>
          <span>Profile</span>
          <select value={props.profile || props.activeProfile} onChange={(event) => props.onProfile(event.target.value)}>
            {profileOptions.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
          </select>
        </label>
        <label className={s.field}>
          <span>投递目标</span>
          <select value={props.deliver} onChange={(event) => props.onDeliver(event.target.value)}>
            {DELIVERY_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className={s.field}>
          <span>名称（可选）</span>
          <input value={props.name} onChange={(event) => props.onName(event.target.value)} placeholder="例如：每日 SEO 巡检" />
        </label>
        <label className={s.field}>
          <span>调度表达式</span>
          <input value={props.schedule} onChange={(event) => props.onSchedule(event.target.value)} placeholder="0 9 * * *" />
        </label>
        <label className={`${s.field} ${s.fieldFull}`}>
          <span>Prompt</span>
          <textarea value={props.prompt} onChange={(event) => props.onPrompt(event.target.value)} placeholder="描述每次定时执行的任务目标、边界和输出要求…" />
        </label>
      </div>
      <div className={s.formActions}>
        <button type="button" className={s.secondaryButton} onClick={props.onCancel} disabled={props.creating}>取消</button>
        <button type="button" className={s.primaryButton} onClick={props.onSubmit} disabled={props.creating}>{props.creating ? "创建中…" : "创建任务"}</button>
      </div>
    </section>
  );
}

interface JobDetailProps {
  job: CronJob;
  busy: boolean;
  onPauseResume: () => void;
  onTrigger: () => void;
  onDelete: () => void;
}

function JobDetail({ job, busy, onPauseResume, onTrigger, onDelete }: JobDetailProps) {
  const paused = isPaused(job);
  return (
    <section className={s.card}>
      <div className={s.cardHeader}>
        <div className={s.titleBlock}>
          <div className={s.breadcrumb}>自动化功能 / {cronJobProfile(job)}</div>
          <h1>{titleOf(job)}</h1>
          <p>{promptPreview(job).slice(0, 180)}</p>
        </div>
        <div className={s.detailActions}>
          <span className={s.statusBadge} data-tone={statusTone(job)}>{statusLabel(job)}</span>
          <button type="button" className={s.secondaryButton} onClick={onPauseResume} disabled={busy}>
            {paused ? <Play size={14} /> : <Pause size={14} />}{paused ? "恢复" : "暂停"}
          </button>
          <button type="button" className={s.primaryButton} onClick={onTrigger} disabled={busy}><Zap size={14} /> 立即运行</button>
          <button type="button" className={s.dangerButton} onClick={onDelete} disabled={busy}><Trash2 size={14} /> 删除</button>
        </div>
      </div>

      <div className={s.statsGrid}>
        <InfoTile icon={<CalendarClock size={15} />} label="调度" value={scheduleDisplay(job)} />
        <InfoTile icon={<Clock size={15} />} label="下次运行" value={formatTime(job.next_run_at ?? job.next_run)} />
        <InfoTile icon={<CheckCircle2 size={15} />} label="上次运行" value={formatTime(job.last_run_at ?? job.last_run)} />
        <InfoTile icon={<AlertCircle size={15} />} label="上次结果" value={resultLine(job)} tone={text(job.last_status) === "error" ? "err" : "neutral"} />
      </div>

      <div className={s.detailGrid}>
        <div className={s.detailItem}>
          <span>运行环境</span>
          <strong>本地</strong>
        </div>
        <div className={s.detailItem}>
          <span>Profile</span>
          <strong>{cronJobProfile(job)}</strong>
        </div>
        <div className={s.detailItem}>
          <span>投递目标</span>
          <strong>{deliveryLabel(text(job.deliver))}</strong>
        </div>
        <div className={s.detailItem}>
          <span>任务 ID</span>
          <strong>{job.id}</strong>
        </div>
      </div>

      {text(job.last_error) ? <div className={s.lastError}>{job.last_error}</div> : null}

      <section className={s.promptCard}>
        <div className={s.promptHeader}>Prompt</div>
        <pre>{text(job.prompt) || text(job.script) || "（无任务描述）"}</pre>
      </section>
    </section>
  );
}

function InfoTile({ icon, label, value, tone = "neutral" }: { icon: React.ReactNode; label: string; value: string; tone?: "neutral" | "err" }) {
  return (
    <div className={s.infoTile} data-tone={tone}>
      <span className={s.infoIcon}>{icon}</span>
      <span className={s.infoText}>
        <span>{label}</span>
        <strong>{value}</strong>
      </span>
    </div>
  );
}
