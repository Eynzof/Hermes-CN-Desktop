import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { debugBus, type DebugEntry, type DebugEntryLevel, type DebugEntryType } from "@/lib/debug-bus";
import { Button, Input } from "@hermes/shared-ui";
import { CopyButton } from "@/components/ui/copy-button";
import s from "./settings.module.css";

const TYPE_OPTIONS: { id: DebugEntryType | "all"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "gateway", label: "Gateway" },
  { id: "rest", label: "REST" },
  { id: "backend", label: "Backend" },
  { id: "console", label: "Console" },
  { id: "exception", label: "Exception" },
];

const LEVEL_OPTIONS: { id: DebugEntryLevel | "all"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "info", label: "info" },
  { id: "warn", label: "warn" },
  { id: "error", label: "error" },
];

function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function useDebugEntries(): DebugEntry[] {
  return useSyncExternalStore(
    (cb) => debugBus.subscribe(() => cb()),
    () => debugBus.snapshot(),
    () => debugBus.snapshot(),
  );
}

interface DebugSectionProps {
  showHeading?: boolean;
}

export function DebugSection({ showHeading = true }: DebugSectionProps) {
  const entries = useDebugEntries();
  const [typeFilter, setTypeFilter] = useState<DebugEntryType | "all">("all");
  const [levelFilter, setLevelFilter] = useState<DebugEntryLevel | "all">("all");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    debugBus.setPaused(paused);
  }, [paused]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (typeFilter !== "all" && entry.type !== typeFilter) return false;
      if (levelFilter !== "all" && entry.level !== levelFilter) return false;
      if (q && !entry.summary.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, typeFilter, levelFilter, search]);

  const counts = useMemo(() => {
    let errors = 0;
    let restFailures = 0;
    for (const e of entries) {
      if (e.level === "error") errors += 1;
      if (e.type === "rest") restFailures += 1;
    }
    return { total: entries.length, errors, restFailures };
  }, [entries]);

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div>
      {showHeading && <h2 className={s.heading}>Debug</h2>}
      <p className={s.desc}>
        实时捕获前端的 Gateway 事件、REST 请求失败、Console 错误与未处理异常。
        最近 {entries.length} 条 · 错误 {counts.errors} · REST 失败 {counts.restFailures}。
        刷新页面后清零，仅保留在内存中。
      </p>

      <div className={s.filterBar}>
        <div className={s.filterGroup}>
          <span className={s.filterLabel}>类型</span>
          <div className={s.segmented}>
            {TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                className={s.segmentBtn}
                data-active={opt.id === typeFilter}
                onClick={() => setTypeFilter(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className={s.filterGroup}>
          <span className={s.filterLabel}>级别</span>
          <div className={s.segmented}>
            {LEVEL_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                className={s.segmentBtn}
                data-active={opt.id === levelFilter}
                onClick={() => setLevelFilter(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={s.logToolbar}>
        <Input
          placeholder="搜索 summary…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <label className={s.autoRefreshLabel}>
          <button
            className={s.toggle}
            data-on={paused}
            onClick={() => setPaused(!paused)}
            title="暂停后新事件不会被记录"
          >
            <span className={s.toggleThumb} />
          </button>
          <span>暂停采集</span>
        </label>
        <Button variant="outline" onClick={() => debugBus.clear()}>清空</Button>
        <CopyButton variant="outline" size="md" text={() => safeStringify(debugBus.snapshot())}>导出 JSON</CopyButton>
      </div>

      <div
        className={s.logBlock}
        style={{ maxHeight: "calc(100vh - 340px)", minHeight: 300 }}
      >
        {filtered.length === 0 ? (
          <div className={s.logLine}>（暂无匹配条目）</div>
        ) : (
          filtered
            .slice()
            .reverse()
            .map((entry) => {
              const isOpen = expanded.has(entry.id);
              const levelClass =
                entry.level === "error"
                  ? s.logLine_error
                  : entry.level === "warn"
                    ? s.logLine_warning
                    : "";
              return (
                <div key={entry.id} className={`${s.logLine} ${levelClass}`}>
                  <button
                    type="button"
                    onClick={() => toggleExpanded(entry.id)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "inherit",
                      font: "inherit",
                      cursor: "pointer",
                      padding: 0,
                      textAlign: "left",
                      display: "block",
                      width: "100%",
                    }}
                  >
                    <span style={{ opacity: 0.65, marginRight: 8 }}>{formatTs(entry.ts)}</span>
                    <span style={{ marginRight: 8, fontWeight: 600 }}>[{entry.type}]</span>
                    <span>{entry.summary}</span>
                  </button>
                  {isOpen && entry.payload !== undefined ? (
                    <pre
                      style={{
                        marginTop: 4,
                        padding: "6px 8px",
                        background: "var(--h-bg-pane)",
                        border: "1px solid var(--h-line-soft)",
                        borderRadius: 4,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                        fontSize: 11,
                      }}
                    >
                      {safeStringify(entry.payload)}
                    </pre>
                  ) : null}
                </div>
              );
            })
        )}
      </div>
    </div>
  );
}
