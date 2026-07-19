import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Copy, Download, FileJson, RefreshCw, RotateCcw, Search, ShieldCheck } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { useLogs } from "@/hooks/use-logs";
import {
  DEFAULT_LOGS_QUERY,
  LOG_COMPONENT_OPTIONS,
  LOG_FILE_OPTIONS,
  LOG_LEVEL_OPTIONS,
  LOG_LINE_COUNT_OPTIONS,
  buildLogJsonl,
  buildLogText,
  classifyLogLine,
  createLogExportFileName,
  filterLogLines,
  logsQueryToSearchParams,
  parseLogsSearchParams,
  type LogComponentOption,
  type LogExportFormat,
  type LogFileOption,
  type LogLevelOption,
  type LogsQueryState,
} from "@/lib/logs-viewer";
import { SectionShell } from "./section-shell";
import s from "./logs.module.css";

const LOG_FILE_LABELS: Record<LogFileOption, string> = {
  agent: "智能体",
  errors: "错误",
  gateway: "网关",
};

const LOG_LEVEL_LABELS: Record<LogLevelOption, string> = {
  ALL: "全部",
  DEBUG: "Debug",
  INFO: "Info",
  WARNING: "Warn",
  ERROR: "Error",
};

const LOG_COMPONENT_LABELS: Record<LogComponentOption, string> = {
  all: "全部",
  gateway: "网关",
  agent: "智能体",
  tools: "工具",
  cli: "CLI",
  cron: "Cron",
  gui: "界面服务",
};

type ExportState = { tone: "normal" | "error"; message: string } | null;

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 72;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function downloadInBrowser(fileName: string, content: string, format: LogExportFormat): void {
  const type = format === "jsonl" ? "application/x-ndjson;charset=utf-8" : "text/plain;charset=utf-8";
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function LogsRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useMemo(() => parseLogsSearchParams(searchParams), [searchParams]);
  const [searchText, setSearchText] = useState(query.q);
  const [exportState, setExportState] = useState<ExportState>(null);
  const [exportingFormat, setExportingFormat] = useState<LogExportFormat | null>(null);
  const [followingTail, setFollowingTail] = useState(true);
  const [hasNewLogs, setHasNewLogs] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastVisibleSignatureRef = useRef("");

  const logs = useLogs(query.file, query.lines, query.level, query.component);
  const rawLines = logs.data?.lines ?? [];
  const visibleLines = useMemo(() => filterLogLines(rawLines, query.q), [rawLines, query.q]);
  const visibleSignature = useMemo(() => visibleLines.join("\n"), [visibleLines]);
  const lastUpdated = logs.dataUpdatedAt ? new Date(logs.dataUpdatedAt).toLocaleTimeString("zh-CN") : "—";
  const hasDesktopExport = typeof window !== "undefined" && Boolean(window.hermesDesktop?.exportLogSnapshot);

  const patchQuery = useCallback((patch: Partial<LogsQueryState>, replace = false) => {
    const current = parseLogsSearchParams(searchParams);
    const next = { ...current, ...patch };
    setSearchParams(logsQueryToSearchParams(next), { replace });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    setSearchText(query.q);
  }, [query.q]);

  useEffect(() => {
    const nextQuery = searchText.trim();
    if (nextQuery === query.q) return;
    const timer = window.setTimeout(() => {
      patchQuery({ q: nextQuery }, true);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [patchQuery, query.q, searchText]);

  useEffect(() => {
    if (!query.live) return;
    const timer = window.setInterval(() => {
      void logs.refetch();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [logs.refetch, query.live]);

  useEffect(() => {
    stickToBottomRef.current = true;
    setFollowingTail(true);
    setHasNewLogs(false);
  }, [query.file, query.level, query.component, query.lines, query.q]);

  useEffect(() => {
    if (lastVisibleSignatureRef.current === visibleSignature) return;
    lastVisibleSignatureRef.current = visibleSignature;
    const element = scrollRef.current;
    if (!element) return;
    if (stickToBottomRef.current) {
      const frame = window.requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight;
        setHasNewLogs(false);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    setHasNewLogs(true);
  }, [visibleSignature]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const nextFollowing = isNearBottom(element);
    stickToBottomRef.current = nextFollowing;
    setFollowingTail(nextFollowing);
    if (nextFollowing) setHasNewLogs(false);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    stickToBottomRef.current = true;
    setFollowingTail(true);
    setHasNewLogs(false);
  }, []);

  const copyVisibleLogs = useCallback(() => buildLogText(visibleLines, { redact: query.redact }), [query.redact, visibleLines]);

  const handleExport = useCallback(async (format: LogExportFormat) => {
    const content = format === "jsonl"
      ? buildLogJsonl(visibleLines, { file: query.file, redact: query.redact })
      : buildLogText(visibleLines, { redact: query.redact });

    if (!content) {
      setExportState({ tone: "error", message: "当前没有可导出的日志。" });
      return;
    }

    const fileName = createLogExportFileName({ file: query.file, format });
    setExportingFormat(format);
    setExportState(null);

    try {
      if (window.hermesDesktop?.exportLogSnapshot) {
        const result = await window.hermesDesktop.exportLogSnapshot({ fileName, content, format });
        if (result.canceled) {
          setExportState({ tone: "normal", message: "已取消导出。" });
        } else if (!result.ok) {
          throw new Error(result.error ?? "导出日志失败");
        } else {
          setExportState({
            tone: "normal",
            message: `已导出 ${formatBytes(result.bytes)}：${result.path ?? fileName}`,
          });
        }
      } else {
        downloadInBrowser(fileName, content, format);
        setExportState({
          tone: "normal",
          message: `已生成 ${formatBytes(new Blob([content]).size)} 的 ${format.toUpperCase()} 下载文件：${fileName}`,
        });
      }
    } catch (error) {
      setExportState({
        tone: "error",
        message: `导出日志失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setExportingFormat(null);
    }
  }, [query.file, query.redact, visibleLines]);

  const clearFilters = useCallback(() => {
    patchQuery(DEFAULT_LOGS_QUERY);
  }, [patchQuery]);

  const errorMessage = logs.error instanceof Error ? logs.error.message : logs.error ? String(logs.error) : "";
  const showBlockingError = logs.isError && !logs.data;

  return (
    <SectionShell
      title="日志"
      sub="查看桌面端的智能体、网关与错误日志；支持选中复制、批量复制和导出当前结果。"
    >
      <div className={s.page}>
        <section className={s.toolbar} aria-label="日志筛选">
          <FilterGroup label="文件">
            {LOG_FILE_OPTIONS.map((file) => (
              <button
                key={file}
                type="button"
                className={s.segmentButton}
                data-active={file === query.file}
                aria-pressed={file === query.file}
                onClick={() => patchQuery({ file })}
              >
                {LOG_FILE_LABELS[file]}
              </button>
            ))}
          </FilterGroup>

          <FilterGroup label="级别">
            {LOG_LEVEL_OPTIONS.map((level) => (
              <button
                key={level}
                type="button"
                className={s.segmentButton}
                data-active={level === query.level}
                aria-pressed={level === query.level}
                onClick={() => patchQuery({ level })}
              >
                {LOG_LEVEL_LABELS[level]}
              </button>
            ))}
          </FilterGroup>

          <FilterGroup label="来源">
            {LOG_COMPONENT_OPTIONS.map((component) => (
              <button
                key={component}
                type="button"
                className={s.segmentButton}
                data-active={component === query.component}
                aria-pressed={component === query.component}
                onClick={() => patchQuery({ component })}
              >
                {LOG_COMPONENT_LABELS[component]}
              </button>
            ))}
          </FilterGroup>

          <FilterGroup label="行数">
            {LOG_LINE_COUNT_OPTIONS.map((lines) => (
              <button
                key={lines}
                type="button"
                className={s.segmentButton}
                data-active={lines === query.lines}
                aria-pressed={lines === query.lines}
                onClick={() => patchQuery({ lines })}
              >
                {lines}
              </button>
            ))}
          </FilterGroup>

          <label className={s.searchBox}>
            <Search size={14} aria-hidden="true" />
            <input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索当前拉取的日志…"
              aria-label="搜索日志"
            />
          </label>
        </section>

        <section className={s.actions} aria-label="日志操作">
          <button
            type="button"
            className={s.toggleButton}
            data-on={query.live}
            onClick={() => patchQuery({ live: !query.live }, true)}
          >
            <span className={s.toggleDot} />
            {query.live ? "自动刷新开启" : "自动刷新关闭"}
          </button>
          <button
            type="button"
            className={s.toggleButton}
            data-on={query.redact}
            onClick={() => patchQuery({ redact: !query.redact }, true)}
            title="影响一键复制和导出文件；手动框选复制仍按屏幕所见复制。"
          >
            <ShieldCheck size={13} />
            {query.redact ? "复制/导出自动脱敏" : "复制/导出保留原文"}
          </button>
          <button type="button" className={s.actionButton} onClick={() => void logs.refetch()} disabled={logs.isFetching}>
            <RefreshCw size={13} className={logs.isFetching ? s.spinIcon : undefined} />
            {logs.isFetching ? "刷新中…" : "刷新"}
          </button>
          <CopyButton className={s.actionButton} text={copyVisibleLogs} disabled={visibleLines.length === 0}>
            <Copy size={13} />
            复制可见日志
          </CopyButton>
          <button
            type="button"
            className={s.actionButton}
            onClick={() => void handleExport("log")}
            disabled={visibleLines.length === 0 || exportingFormat !== null}
          >
            <Download size={13} />
            {exportingFormat === "log" ? "导出中…" : "导出 .log"}
          </button>
          <button
            type="button"
            className={s.actionButton}
            onClick={() => void handleExport("jsonl")}
            disabled={visibleLines.length === 0 || exportingFormat !== null}
          >
            <FileJson size={13} />
            {exportingFormat === "jsonl" ? "导出中…" : "导出 JSONL"}
          </button>
          <button type="button" className={s.actionButton} onClick={clearFilters}>
            <RotateCcw size={13} />
            清空筛选
          </button>
        </section>

        <div className={s.metaLine}>
          <span>显示 {visibleLines.length}/{rawLines.length} 行</span>
          <span>最后更新 {lastUpdated}</span>
          <span>{followingTail ? "正在跟随最新日志" : "已暂停跟随，便于查看历史"}</span>
          <span>{hasDesktopExport ? "桌面保存对话框可用" : "浏览器下载模式"}</span>
          {query.q && <span>搜索仅覆盖当前拉取的 {rawLines.length} 行</span>}
        </div>

        {exportState && (
          <div className={s.feedback} data-tone={exportState.tone === "error" ? "error" : undefined}>
            {exportState.message}
          </div>
        )}
        {logs.isError && logs.data && (
          <div className={s.feedback} data-tone="error">
            刷新失败，已保留上次成功读取的日志：{errorMessage || "未知错误"}
          </div>
        )}

        {showBlockingError ? (
          <div className={s.errorCard}>
            <b>日志加载失败</b>
            <p>{errorMessage || "未知错误"}</p>
            <div className={s.errorActions}>
              <button type="button" className={s.actionButton} onClick={() => void logs.refetch()}>
                重试
              </button>
              <Link className={s.actionLink} to="/debug">
                去 Debug 导出排障包
              </Link>
            </div>
          </div>
        ) : (
          <div className={s.viewerWrap}>
            {hasNewLogs && (
              <button type="button" className={s.newLogsButton} onClick={scrollToBottom}>
                有新日志，回到底部
              </button>
            )}
            <div
              ref={scrollRef}
              className={s.logViewport}
              onScroll={handleScroll}
              role="log"
              aria-live={query.live && followingTail ? "polite" : "off"}
            >
              {visibleLines.map((line, index) => {
                const tone = classifyLogLine(line);
                return (
                  <div key={`${index}-${line}`} className={s.logLine} data-tone={tone}>
                    <span className={s.lineNumber}>{index + 1}</span>
                    <span className={s.lineText}>{line}</span>
                  </div>
                );
              })}
              {logs.isLoading && visibleLines.length === 0 && <EmptyLine>日志加载中…</EmptyLine>}
              {!logs.isLoading && rawLines.length === 0 && <EmptyLine>Hermes 还没产生日志，可能是刚启动。</EmptyLine>}
              {!logs.isLoading && rawLines.length > 0 && visibleLines.length === 0 && (
                <EmptyLine>没有匹配的日志，请调整关键词或清空筛选。</EmptyLine>
              )}
            </div>
          </div>
        )}
      </div>
    </SectionShell>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.filterGroup}>
      <span className={s.filterLabel}>{label}</span>
      <div className={s.segmented}>{children}</div>
    </div>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <div className={s.emptyLine}>{children}</div>;
}
