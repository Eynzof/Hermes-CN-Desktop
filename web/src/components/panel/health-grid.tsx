import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useStatus } from "@/hooks/use-status";
import { useConfig, useModelInfo } from "@/hooks/use-config";
import { useEnvVars } from "@/hooks/use-env";
import { useSkills } from "@/hooks/use-skills";
import { useMcpServers } from "@/hooks/use-mcp-servers";
import { useLastUsedModel } from "@/lib/last-used-model";
import { readUiValue, writeUiValue } from "@/lib/ui-store";
import { Dot } from "@/components/ui/pill";
import s from "./health-grid.module.css";

const STORAGE_KEY = "hermes:panel:health-open";
const DEFAULT_DESKTOP_DASHBOARD_ORIGIN = "127.0.0.1:9120";

type Tone = "ok" | "warn" | "err";

interface CellData {
  label: string;
  tone: Tone;
  value: string;
  sub?: string;
  mono?: boolean;
  title?: string;
  wide?: boolean;
  actionTo?: string;
}

function formatContextLength(n: number | undefined | null): string {
  if (!n || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M ctx`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k ctx`;
  return `${n} ctx`;
}

function readOpen(): boolean {
  return readUiValue(STORAGE_KEY, false);
}

function writeOpen(open: boolean) {
  writeUiValue(STORAGE_KEY, open);
}

function originFromHealthUrl(url: string | null | undefined): string {
  if (!url) return DEFAULT_DESKTOP_DASHBOARD_ORIGIN;
  try {
    return new URL(url).host || DEFAULT_DESKTOP_DASHBOARD_ORIGIN;
  } catch {
    return DEFAULT_DESKTOP_DASHBOARD_ORIGIN;
  }
}

function Cell({ cell, onNavigate }: { cell: CellData; onNavigate: (to: string) => void }) {
  const title = cell.title ?? [cell.value, cell.sub].filter(Boolean).join(" · ");
  const content = (
    <>
      <div className={s.label}>
        <Dot tone={cell.tone} />
        <span>{cell.label}</span>
      </div>
      <div className={s.value} data-mono={cell.mono ? "true" : undefined}>{cell.value}</div>
      {cell.sub && <div className={s.sub}>{cell.sub}</div>}
    </>
  );

  if (cell.actionTo) {
    const actionTo = cell.actionTo;
    return (
      <button
        type="button"
        className={s.cell}
        data-size={cell.wide ? "wide" : undefined}
        data-warn={cell.tone === "warn" ? "true" : undefined}
        data-err={cell.tone === "err" ? "true" : undefined}
        data-action="true"
        title={title}
        aria-label={`${cell.label}: ${cell.value}${cell.sub ? `，${cell.sub}` : ""}`}
        onClick={() => onNavigate(actionTo)}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={s.cell}
      data-size={cell.wide ? "wide" : undefined}
      data-warn={cell.tone === "warn" ? "true" : undefined}
      data-err={cell.tone === "err" ? "true" : undefined}
      title={title}
    >
      {content}
    </div>
  );
}

export function HealthGrid() {
  const navigate = useNavigate();
  const { data: status } = useStatus();
  const { data: modelInfo } = useModelInfo();
  const { data: config } = useConfig();
  const { data: env } = useEnvVars();
  const { data: skills } = useSkills();
  const { data: mcp, isError: mcpError } = useMcpServers();
  const lastUsedModel = useLastUsedModel();
  const [open, setOpen] = useState(readOpen);

  useEffect(() => {
    writeOpen(open);
  }, [open]);

  const cells = useMemo<CellData[]>(() => {
    // `gateway_running` is the *PTY daemon* status — a Python subprocess
    // the dashboard *can* spawn for the embedded chat tab. With P-009
    // the SSE+POST transport calls tui_gateway.dispatch() in-process,
    // so the daemon stays "stopped" by design and that's fine. The real
    // health signal is whether the dashboard responded to /api/status
    // at all — that's `!!status` (React Query keeps `data` undefined
    // on transport / 5xx errors).
    const dashboardReachable = !!status;
    const daemonRunning = status?.gateway_running === true;
    const gatewayState =
      status?.gateway_state || (daemonRunning ? "running" : "stopped");

    const tokenKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GLM_API_KEY", "DEEPSEEK_API_KEY"];
    const setTokens = env ? tokenKeys.filter((k) => env[k]?.is_set) : [];
    const anyTokenSet = setTokens.length > 0;

    const hermesHome = status?.hermes_home;
    const dashboardOrigin = originFromHealthUrl(status?.gateway_health_url);

    const modelName = lastUsedModel?.model || modelInfo?.model || "—";
    const ctxLabel = formatContextLength(
      lastUsedModel?.contextWindow
        ?? modelInfo?.effective_context_length
        ?? modelInfo?.auto_context_length,
    );

    const skillsTotal = skills?.length ?? 0;
    const skillsEnabled = skills?.filter((sk) => sk.enabled).length ?? 0;

    const mcpTotal = mcp?.summary.total ?? 0;
    const mcpEnabled = mcp?.summary.enabled ?? 0;

    // Provider api_key sanity check.
    // Catches a common foot-gun in `~/.hermes/config.yaml` where the user pastes
    // base_url into the api_key field by mistake (or vice-versa). Dashboard's
    // `list_authenticated_providers` doesn't validate the key shape — the broken
    // provider stays in the model picker, then any session that lands on it
    // sends `Authorization: Bearer https://...` to the upstream API and 401s
    // (sometimes manifesting as obscure credential-pool warnings).
    const providers = (config?.providers as Record<string, { api_key?: unknown }> | undefined) || {};
    const invalidProviders: string[] = [];
    for (const [name, cfg] of Object.entries(providers)) {
      const key = typeof cfg?.api_key === "string" ? cfg.api_key.trim() : "";
      if (key && /^https?:\/\//i.test(key)) invalidProviders.push(name);
    }
    const providerTotal = Object.keys(providers).length;
    const providersOk = providerTotal > 0 && invalidProviders.length === 0;

    return [
      {
        label: "Gateway",
        tone: dashboardReachable ? "ok" : "err",
        value: dashboardOrigin,
        sub: dashboardReachable
          ? daemonRunning
            ? "运行中"
            : "就绪 · in-process"
          : "未响应",
        mono: true,
        wide: true,
        title: `dashboardReachable=${dashboardReachable}; gateway_state=${gatewayState}. P-009 后 SSE+POST 走进程内 dispatch，gateway_state=stopped 是预期值。`,
      },
      {
        label: "Hermes Home",
        tone: "ok",
        value: hermesHome || "—",
        sub: hermesHome ? "可读" : undefined,
        mono: true,
        wide: true,
      },
      {
        label: "模型",
        tone: modelName !== "—" ? "ok" : "warn",
        value: modelName,
        sub: modelName !== "—" ? ctxLabel : "前往模型设置",
        mono: true,
        wide: true,
        actionTo: modelName === "—" ? "/models" : undefined,
      },
      {
        label: "Token",
        tone: anyTokenSet ? "ok" : "warn",
        value: anyTokenSet ? "已配置" : "未配置",
        sub: anyTokenSet
          ? setTokens.join(" · ").toLowerCase().replace(/_api_key/g, "")
          : "前往模型设置",
        actionTo: anyTokenSet ? undefined : "/models",
      },
      {
        label: "Skills",
        tone: skillsEnabled > 0 ? "ok" : "warn",
        value: `${skillsEnabled} 启用`,
        sub: `共 ${skillsTotal}`,
      },
      {
        label: "MCP",
        tone: mcpError ? "err" : mcpTotal === 0 ? "warn" : "ok",
        value: mcpError ? "未接入" : `${mcpEnabled} / ${mcpTotal}`,
        sub: mcpError ? "需重启 dashboard" : mcpTotal === 0 ? "未配置" : `共 ${mcpTotal}`,
        mono: !mcpError,
      },
      {
        label: "Provider 配置",
        tone: providersOk ? "ok" : invalidProviders.length > 0 ? "warn" : "warn",
        value: providerTotal === 0
          ? "未配置"
          : invalidProviders.length > 0
            ? `${invalidProviders.length} / ${providerTotal} 异常`
            : `${providerTotal} 个有效`,
        sub: invalidProviders.length > 0
          ? `api_key 是 URL: ${invalidProviders.join(", ")}`
          : providerTotal === 0
            ? "前往模型设置"
            : "api_key 字段健康",
        title: invalidProviders.length > 0
          ? `这些 provider 的 api_key 字段填的是 URL 不是真 key，会让 dashboard 发请求时把 URL 当 Bearer token，必定 401。请到 ~/.hermes/config.yaml 修正。`
          : providerTotal === 0
            ? "config.yaml 缺 providers。点击进入模型页选择服务商，填写 API Key，并设为当前模型。"
            : undefined,
        actionTo: providerTotal === 0 || invalidProviders.length > 0 ? "/models" : undefined,
      },
    ];
  }, [config, env, lastUsedModel, mcp, mcpError, modelInfo, skills, status]);

  const counts = useMemo(() => {
    let ok = 0;
    let warn = 0;
    let err = 0;
    for (const c of cells) {
      if (c.tone === "ok") ok += 1;
      else if (c.tone === "warn") warn += 1;
      else err += 1;
    }
    return { ok, warn, err };
  }, [cells]);

  const overallTone: Tone =
    counts.err > 0 ? "err" : counts.warn > 0 ? "warn" : "ok";

  const summaryLabel =
    overallTone === "err"
      ? `${counts.err} 项异常`
      : overallTone === "warn"
        ? `${counts.warn} 项需要关注`
        : "系统正常";

  const summarySub = `${counts.ok}/${cells.length} 项 OK${counts.warn > 0 ? ` · ${counts.warn} warn` : ""}${counts.err > 0 ? ` · ${counts.err} err` : ""}`;

  return (
    <div>
      <button
        type="button"
        className={s.bar}
        data-tone={overallTone}
        data-open={open}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Dot tone={overallTone} />
        <span className={s.barLabel}>{summaryLabel}</span>
        <span className={s.barSummary}>{summarySub}</span>
        <span className={s.barChev} aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className={s.grid}>
          {cells.map((cell) => (
            <Cell key={cell.label} cell={cell} onNavigate={navigate} />
          ))}
        </div>
      )}
    </div>
  );
}
