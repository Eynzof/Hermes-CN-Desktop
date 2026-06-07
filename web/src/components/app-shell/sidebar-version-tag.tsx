import { useRuntimeInfo } from "@/hooks/use-runtime-update";
import { useStatus } from "@/hooks/use-status";
import { BUILD_COMMIT, DESKTOP_VERSION, UNKNOWN_VALUE, versionLabel } from "@/lib/build-info";
import type { RuntimeInfo, StatusResponse } from "@hermes/protocol";
import s from "./app-shell.module.css";


function shortCommit(commit: string | undefined): string {
  const normalized = commit?.trim() ?? "";
  if (!normalized || normalized === "unknown") return UNKNOWN_VALUE;
  return normalized.slice(0, 4);
}

export interface SidebarVersionRowsInput {
  status?: Pick<StatusResponse, "version" | "release_date">;
  runtimeInfo?: RuntimeInfo;
  buildCommit?: string;
  desktopVersion?: string;
}

export interface SidebarVersionLine {
  label: "内核" | "界面";
  version: string;
  commit: string;
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
  desktopVersion = DESKTOP_VERSION,
}: SidebarVersionRowsInput): SidebarVersionRows {
  const kernelVersion = versionLabel(runtimeInfo?.current?.kernelVersion ?? status?.version);
  const kernelCommit = shortCommit(runtimeInfo?.current?.sourceCommit);
  const uiVersion = versionLabel(desktopVersion);
  const uiCommit = shortCommit(buildCommit);

  return {
    kernel: `内核 ${kernelVersion} · ${kernelCommit}`,
    ui: `界面 ${uiVersion} · ${uiCommit}`,
    kernelLine: {
      label: "内核",
      version: kernelVersion,
      commit: kernelCommit,
    },
    uiLine: {
      label: "界面",
      version: uiVersion,
      commit: uiCommit,
    },
    title: `内核 ${kernelVersion} · ${kernelCommit}\n界面 ${uiVersion} · ${uiCommit}`,
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
    </div>
  );
}
