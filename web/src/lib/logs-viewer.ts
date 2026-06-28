import { redactSummary } from "./debug-redact";

export const LOG_FILE_OPTIONS = ["agent", "errors", "gateway"] as const;
export const LOG_LEVEL_OPTIONS = ["ALL", "DEBUG", "INFO", "WARNING", "ERROR"] as const;
// Must match the backend's COMPONENT_PREFIXES (hermes_logging.py): the only
// components /api/logs accepts are gateway, agent, tools, cli, cron, gui. The
// previous mcp/skill/task entries had no backend log namespace and made the API
// reject the request with HTTP 400 (MCP logs live under `tools`, not a separate
// component). "gui" covers web_server / pty_bridge / tui_gateway / uvicorn.
export const LOG_COMPONENT_OPTIONS = ["all", "gateway", "agent", "tools", "cli", "cron", "gui"] as const;
export const LOG_LINE_COUNT_OPTIONS = [50, 100, 200, 500] as const;

export type LogFileOption = (typeof LOG_FILE_OPTIONS)[number];
export type LogLevelOption = (typeof LOG_LEVEL_OPTIONS)[number];
export type LogComponentOption = (typeof LOG_COMPONENT_OPTIONS)[number];
export type LogExportFormat = "log" | "jsonl";
export type LogLineTone = "error" | "warning" | "debug" | "info";

export interface LogsQueryState {
  file: LogFileOption;
  level: LogLevelOption;
  component: LogComponentOption;
  lines: (typeof LOG_LINE_COUNT_OPTIONS)[number];
  q: string;
  live: boolean;
  redact: boolean;
}

export interface BuildLogExportOptions {
  file: string;
  redact: boolean;
}

export const DEFAULT_LOGS_QUERY: LogsQueryState = {
  file: "agent",
  level: "ALL",
  component: "all",
  lines: 200,
  q: "",
  live: true,
  redact: true,
};

function isOneOf<T extends readonly string[]>(value: string | null, options: T): value is T[number] {
  return value !== null && (options as readonly string[]).includes(value);
}

function normalizeLineCount(value: string | null): LogsQueryState["lines"] {
  const parsed = Number(value);
  if (LOG_LINE_COUNT_OPTIONS.includes(parsed as LogsQueryState["lines"])) {
    return parsed as LogsQueryState["lines"];
  }
  return DEFAULT_LOGS_QUERY.lines;
}

function normalizeBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return fallback;
}

export function parseLogsSearchParams(params: URLSearchParams): LogsQueryState {
  const file = params.get("file");
  const level = params.get("level")?.toUpperCase() ?? null;
  const component = params.get("component") ?? params.get("source");

  return {
    file: isOneOf(file, LOG_FILE_OPTIONS) ? file : DEFAULT_LOGS_QUERY.file,
    level: isOneOf(level, LOG_LEVEL_OPTIONS) ? level : DEFAULT_LOGS_QUERY.level,
    component: isOneOf(component, LOG_COMPONENT_OPTIONS) ? component : DEFAULT_LOGS_QUERY.component,
    lines: normalizeLineCount(params.get("lines")),
    q: params.get("q")?.trim() ?? DEFAULT_LOGS_QUERY.q,
    live: normalizeBoolean(params.get("live"), DEFAULT_LOGS_QUERY.live),
    redact: normalizeBoolean(params.get("redact"), DEFAULT_LOGS_QUERY.redact),
  };
}

export function logsQueryToSearchParams(query: LogsQueryState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("file", query.file);
  params.set("level", query.level);
  params.set("component", query.component);
  params.set("lines", String(query.lines));
  params.set("live", query.live ? "1" : "0");
  params.set("redact", query.redact ? "1" : "0");
  if (query.q.trim()) params.set("q", query.q.trim());
  return params;
}

export function classifyLogLine(line: string): LogLineTone {
  const upper = line.toUpperCase();
  if (upper.includes("ERROR") || upper.includes("CRITICAL") || upper.includes("FATAL")) return "error";
  if (upper.includes("WARNING") || upper.includes("WARN")) return "warning";
  if (upper.includes("DEBUG")) return "debug";
  return "info";
}

export function logLevelFromLine(line: string): Exclude<LogLevelOption, "ALL"> {
  const tone = classifyLogLine(line);
  if (tone === "error") return "ERROR";
  if (tone === "warning") return "WARNING";
  if (tone === "debug") return "DEBUG";
  return "INFO";
}

export function filterLogLines(lines: string[], query: string): string[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return lines;
  return lines.filter((line) => {
    const haystack = line.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function redactLogLine(line: string): string {
  return redactSummary(line);
}

export function buildLogText(lines: string[], options: { redact: boolean }): string {
  if (lines.length === 0) return "";
  const body = options.redact ? lines.map(redactLogLine).join("\n") : lines.join("\n");
  return `${body}\n`;
}

function parseTimestamp(line: string): string | null {
  const match = line.match(/\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}:\d{2}(?:[.,]\d{3,6})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/u);
  return match?.[0] ?? null;
}

function parseSource(line: string): string | null {
  const match = line.match(/\[([A-Za-z0-9_.:-]{2,})\]/u);
  return match?.[1] ?? null;
}

export function buildLogJsonl(lines: string[], options: BuildLogExportOptions): string {
  if (lines.length === 0) return "";
  return lines
    .map((line, index) => {
      const raw = options.redact ? redactLogLine(line) : line;
      return JSON.stringify({
        file: options.file,
        lineNumber: index + 1,
        level: logLevelFromLine(raw),
        source: parseSource(raw),
        timestamp: parseTimestamp(raw),
        message: raw,
        raw,
      });
    })
    .join("\n") + "\n";
}

export function createLogExportFileName(
  input: { file: string; format: LogExportFormat },
  now = new Date(),
): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z").replace("T", "-").replace("Z", "");
  return `hermes-logs-${input.file}-${stamp}.${input.format}`;
}
