import { useRuntimeInfo } from "@/hooks/use-runtime-update";
import { useStatus } from "@/hooks/use-status";
import { BUILD_COMMIT, BUILD_DATE, DESKTOP_VERSION, UNKNOWN_DATE, UNKNOWN_VALUE, versionLabel } from "@/lib/build-info";
import type { RuntimeInfo, StatusResponse } from "@hermes/protocol";
import s from "./app-shell.module.css";


function shortCommit(commit: string | undefined): string {
  const normalized = commit?.trim() ?? "";
  if (!normalized || normalized === "unknown") return UNKNOWN_VALUE;
  return normalized.slice(0, 4);
}

function fullCommitDate(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized === "unknown") return UNKNOWN_DATE;
  const datePrefix = normalized.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (datePrefix) return datePrefix;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return UNKNOWN_DATE;
  return date.toISOString().slice(0, 10);
}

function shortCommitDate(value: string | undefined): string {
  const full = fullCommitDate(value);
  const match = full.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}.${match[2]}` : full;
}

function runtimeCommitDate(runtimeInfo: RuntimeInfo | undefined, compact: boolean): string {
  const sourceCommit = runtimeInfo?.current?.sourceCommit?.trim();
  if (!sourceCommit) return UNKNOWN_DATE;
  const match = runtimeInfo?.source?.recentCommits.find((commit) =>
    commit.hash === sourceCommit || commit.hash.startsWith(sourceCommit) || sourceCommit.startsWith(commit.hash),
  );
  return compact ? shortCommitDate(match?.date) : fullCommitDate(match?.date);
}

export interface SidebarVersionRowsInput {
  status?: Pick<StatusResponse, "version" | "release_date">;
  runtimeInfo?: RuntimeInfo;
  buildCommit?: string;
  buildDate?: string;
  desktopVersion?: string;
}

export interface SidebarVersionLine {
  label: "内核" | "界面";
  version: string;
  commit: string;
  date: string;
}

export interface SidebarVersionRows {
  kernel: string;
  ui: string;
  kernelLine: SidebarVersionLine;
  uiLine: SidebarVersionLine;
  title: string;
}

export function buildSidebarVersionRows({
  status,
  runtimeInfo,
  buildCommit = BUILD_COMMIT,
  buildDate = BUILD_DATE,
  desktopVersion = DESKTOP_VERSION,
}: SidebarVersionRowsInput): SidebarVersionRows {
  const kernelVersion = versionLabel(runtimeInfo?.current?.kernelVersion ?? status?.version);
  const kernelCommit = shortCommit(runtimeInfo?.current?.sourceCommit);
  const kernelDate = runtimeCommitDate(runtimeInfo, true);
  const kernelFullDate = runtimeCommitDate(runtimeInfo, false);
  const uiVersion = versionLabel(desktopVersion);
  const uiCommit = shortCommit(buildCommit);
  const uiDate = shortCommitDate(buildDate);
  const uiFullDate = fullCommitDate(buildDate);

  return {
    kernel: `内核 ${kernelVersion} · ${kernelCommit} · ${kernelDate}`,
    ui: `界面 ${uiVersion} · ${uiCommit} · ${uiDate}`,
    kernelLine: {
      label: "内核",
      version: kernelVersion,
      commit: kernelCommit,
      date: kernelDate,
    },
    uiLine: {
      label: "界面",
      version: uiVersion,
      commit: uiCommit,
      date: uiDate,
    },
    title: `内核 ${kernelVersion} · ${kernelCommit} · ${kernelFullDate}\n界面 ${uiVersion} · ${uiCommit} · ${uiFullDate}\n预览版本，不代表最终品质`,
  };
}

function VersionLine({
  accent,
  line,
  text,
}: {
  accent?: boolean;
  line: SidebarVersionLine;
  text: string;
}) {
  return (
    <div
      className={`${s.sidebarInfoRow} ${accent ? s.sidebarInfoVersion : ""}`}
      aria-label={text}
    >
      <span className={s.sidebarInfoCell}>{line.label}</span>
      <span className={s.sidebarInfoCell}>{line.version}</span>
      <span className={s.sidebarInfoDot} aria-hidden="true">·</span>
      <span className={s.sidebarInfoCell}>{line.commit}</span>
      <span className={s.sidebarInfoDot} aria-hidden="true">·</span>
      <span className={s.sidebarInfoCell}>{line.date}</span>
    </div>
  );
}

export function SidebarVersionTag() {
  const { data: status } = useStatus();
  const { data: runtimeInfo } = useRuntimeInfo();
  const rows = buildSidebarVersionRows({ status, runtimeInfo });
  return (
    <div
      className={s.sidebarInfoPanel}
      aria-label="构建与运行信息"
      title={rows.title}
    >
      <div className={s.sidebarInfoMeta}>
        <VersionLine accent line={rows.kernelLine} text={rows.kernel} />
        <VersionLine line={rows.uiLine} text={rows.ui} />
      </div>
      <div className={s.sidebarInfoNote}>预览版本，不代表最终品质</div>
    </div>
  );
}
