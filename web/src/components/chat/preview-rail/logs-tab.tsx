import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useLogs } from "@/hooks/use-logs";
import {
  DEFAULT_LOGS_QUERY,
  LOG_FILE_OPTIONS,
  classifyLogLine,
  filterLogLines,
  type LogFileOption,
} from "@/lib/logs-viewer";
import s from "./preview-rail.module.css";

const FILE_LABELS: Record<LogFileOption, string> = {
  agent: "Agent",
  errors: "Errors",
  gateway: "Gateway",
};

// Compact, in-rail logs viewer. Reuses the data layer (useLogs) and the pure
// filter/classify helpers from lib/logs-viewer with local state, so it doesn't
// touch the detail URL. The standalone /logs route remains the full-featured
// viewer (level/component filters, export, redaction).
export function LogsTab() {
  const [file, setFile] = useState<LogFileOption>(DEFAULT_LOGS_QUERY.file);
  const [search, setSearch] = useState("");
  const logs = useLogs(file, DEFAULT_LOGS_QUERY.lines);
  const viewportRef = useRef<HTMLDivElement>(null);

  const rawLines = logs.data?.lines ?? [];
  const visible = useMemo(() => filterLogLines(rawLines, search), [rawLines, search]);
  const signature = visible.join("\n");

  // Poll for new logs while the tab is open.
  useEffect(() => {
    const timer = window.setInterval(() => void logs.refetch(), 5_000);
    return () => window.clearInterval(timer);
  }, [logs]);

  // Auto-scroll to the newest line on update.
  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [signature]);

  return (
    <>
      <div className={s.bar}>
        <div className={s.segmented}>
          {LOG_FILE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={s.segmentButton}
              data-active={option === file ? "true" : undefined}
              onClick={() => setFile(option)}
            >
              {FILE_LABELS[option]}
            </button>
          ))}
        </div>
        <label className={s.input} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Search size={13} aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索…"
            aria-label="搜索日志"
            style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", color: "inherit", outline: "none", font: "inherit" }}
          />
        </label>
      </div>
      <div ref={viewportRef} className={s.logViewport} role="log">
        {visible.map((line, index) => (
          <div key={`${index}-${line}`} className={s.logLine} data-tone={classifyLogLine(line)}>
            <span className={s.lineNumber}>{index + 1}</span>
            <span className={s.lineText}>{line}</span>
          </div>
        ))}
        {logs.isLoading && visible.length === 0 ? <div className={s.crumb}>日志加载中…</div> : null}
        {!logs.isLoading && rawLines.length === 0 ? <div className={s.crumb}>暂无日志。</div> : null}
        {!logs.isLoading && rawLines.length > 0 && visible.length === 0 ? (
          <div className={s.crumb}>没有匹配的日志。</div>
        ) : null}
      </div>
    </>
  );
}
