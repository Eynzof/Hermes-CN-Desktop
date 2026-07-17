import { atom } from "jotai";
import type { GatewayEvent } from "@hermes/protocol";

// 子代理（subagent）监视状态。后端（Hermes-CN-Core tui_gateway/server.py 的
// _on_tool_progress）通过 /api/ws 下发 subagent.* 事件，payload 字段已与后端核对：
//   goal, task_count, task_index, subagent_id, parent_id, depth, model,
//   tool_count, toolsets, input_tokens, output_tokens, reasoning_tokens,
//   api_calls, cost_usd, files_read, files_written,
//   output_tail[{tool, preview, is_error}], tool_name, text, status,
//   summary, duration_seconds
// 逻辑移植自官方桌面端 apps/desktop/src/store/subagents.ts（nanostores → Jotai），
// 纯函数化以便单测。详见 issue #238。

export type SubagentStatus = "completed" | "failed" | "interrupted" | "queued" | "running";
export type SubagentStreamKind = "progress" | "summary" | "thinking" | "tool";

export interface SubagentStreamEntry {
  at: number;
  isError?: boolean;
  kind: SubagentStreamKind;
  text: string;
}

export interface SubagentProgress {
  id: string;
  parentId: string | null;
  goal: string;
  model?: string;
  status: SubagentStatus;
  taskCount: number;
  taskIndex: number;
  startedAt: number;
  updatedAt: number;
  durationSeconds?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCount?: number;
  filesRead: string[];
  filesWritten: string[];
  stream: SubagentStreamEntry[];
  summary?: string;
  /** Active tool while running — cleared on terminal status. */
  currentTool?: string;
}

export interface SubagentNode extends SubagentProgress {
  children: SubagentNode[];
}

export type SubagentPayload = Record<string, unknown>;

const TERMINAL: ReadonlySet<SubagentStatus> = new Set(["completed", "failed", "interrupted"]);
const MAX_STREAM = 24;
const PREVIEW_MAX = 220;
const TOOL_PREVIEW_MAX = 96;

export const SUBAGENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "subagent.spawn_requested",
  "subagent.start",
  "subagent.thinking",
  "subagent.tool",
  "subagent.progress",
  "subagent.complete",
]);

const isStr = (v: unknown): v is string => typeof v === "string";
const str = (v: unknown) => (isStr(v) ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strList = (v: unknown) => (Array.isArray(v) ? v.filter(isStr) : []);

const asStatus = (v: unknown): SubagentStatus =>
  v === "completed" || v === "failed" || v === "interrupted" || v === "queued" ? v : "running";

const compact = (text: string, max = PREVIEW_MAX) => {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const toolLabel = (name: string) =>
  name
    .split("_")
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(" ") || name;

const formatTool = (name: string, preview = "") => {
  const snippet = compact(preview, TOOL_PREVIEW_MAX);
  return snippet ? `${toolLabel(name)}("${snippet}")` : toolLabel(name);
};

interface TailEntry {
  isError?: boolean;
  preview?: string;
  tool?: string;
}

const asTail = (v: unknown): TailEntry[] =>
  Array.isArray(v)
    ? v
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({
          isError: item.is_error === true,
          preview: str(item.preview) || undefined,
          tool: str(item.tool) || undefined,
        }))
    : [];

export const idOf = (p: SubagentPayload) =>
  str(p.subagent_id) || `${str(p.parent_id) || "root"}:${num(p.task_index) ?? 0}:${str(p.goal)}`;

const appendStream = (stream: SubagentStreamEntry[], entry: SubagentStreamEntry) => {
  const last = stream.at(-1);
  if (last?.kind === entry.kind && last.text === entry.text && last.isError === entry.isError) {
    return stream;
  }
  return [...stream, entry].slice(-MAX_STREAM);
};

function streamFromPayload(
  payload: SubagentPayload,
  status: SubagentStatus,
  eventType: string,
  at: number,
): SubagentStreamEntry[] {
  const out: SubagentStreamEntry[] = [];
  const tool = str(payload.tool_name);
  const preview = str(payload.tool_preview) || str(payload.text);
  const text = compact(str(payload.text) || preview);

  for (const tail of asTail(payload.output_tail)) {
    const line = tail.tool ? formatTool(tail.tool, tail.preview ?? "") : compact(tail.preview ?? "");
    if (line) {
      out.push({ at, isError: tail.isError, kind: tail.tool ? "tool" : "progress", text: line });
    }
  }

  if (tool) {
    out.push({ at, isError: !!payload.error, kind: "tool", text: formatTool(tool, preview) });
  }

  if (eventType === "subagent.progress" && text) {
    out.push({ at, isError: !!payload.error, kind: "progress", text });
  }

  if (eventType === "subagent.thinking" && text) {
    out.push({ at, kind: "thinking", text });
  }

  const summary = compact(str(payload.summary) || str(payload.text));
  if (TERMINAL.has(status) && summary) {
    out.push({ at, isError: status === "failed", kind: "summary", text: summary });
  }

  return out;
}

function toProgress(
  payload: SubagentPayload,
  prev: SubagentProgress | undefined,
  eventType: string,
  now: number,
): SubagentProgress {
  const status = asStatus(payload.status);
  const tool = str(payload.tool_name);
  const stream = streamFromPayload(payload, status, eventType, now).reduce(appendStream, prev?.stream ?? []);
  const filesRead = strList(payload.files_read);
  const filesWritten = strList(payload.files_written);

  return {
    id: prev?.id ?? idOf(payload),
    parentId: str(payload.parent_id) || prev?.parentId || null,
    goal: str(payload.goal) || prev?.goal || "Subagent",
    model: str(payload.model) || prev?.model,
    status,
    taskCount: num(payload.task_count) ?? prev?.taskCount ?? 1,
    taskIndex: num(payload.task_index) ?? prev?.taskIndex ?? 0,
    startedAt: prev?.startedAt ?? now,
    updatedAt: now,
    durationSeconds: num(payload.duration_seconds) ?? prev?.durationSeconds,
    costUsd: num(payload.cost_usd) ?? prev?.costUsd,
    inputTokens: num(payload.input_tokens) ?? prev?.inputTokens,
    outputTokens: num(payload.output_tokens) ?? prev?.outputTokens,
    toolCount: num(payload.tool_count) ?? prev?.toolCount,
    filesRead: filesRead.length ? filesRead : (prev?.filesRead ?? []),
    filesWritten: filesWritten.length ? filesWritten : (prev?.filesWritten ?? []),
    stream,
    summary: str(payload.summary) || prev?.summary,
    currentTool: TERMINAL.has(status) ? undefined : tool || prev?.currentTool,
  };
}

// 跨回合保留的行数上限：debug 场景下已结束的子代理留在面板里，防无限累积。
const MAX_ITEMS = 40;

/** Pure upsert: returns a new list (or the same ref if nothing changed). Terminal
 *  subagents are frozen — late events for a completed/failed branch are ignored. */
export function reduceSubagentList(
  list: readonly SubagentProgress[],
  payload: SubagentPayload,
  createIfMissing: boolean,
  eventType: string,
  now: number,
): SubagentProgress[] {
  const arr = list as SubagentProgress[];
  const id = idOf(payload);
  const idx = arr.findIndex((item) => item.id === id);
  if (idx < 0 && !createIfMissing) return arr;
  const prev = idx >= 0 ? arr[idx] : undefined;
  if (prev && TERMINAL.has(prev.status)) return arr;
  const next = toProgress(payload, prev, eventType, now);
  if (idx >= 0) return arr.map((item) => (item.id === id ? next : item));
  const appended = [...arr, next];
  return appended.length > MAX_ITEMS ? appended.slice(-MAX_ITEMS) : appended;
}

/** 新回合开始：上一轮仍未收尾的行标记为 interrupted（事件流没走完），
 *  已终态的行原样保留。返回同引用表示无变化。 */
export function markUnfinishedInterrupted(list: readonly SubagentProgress[]): SubagentProgress[] {
  if (!list.some((item) => !TERMINAL.has(item.status))) return list as SubagentProgress[];
  return list.map((item) =>
    TERMINAL.has(item.status) ? item : { ...item, status: "interrupted" as const },
  );
}

/** 面板「清空已结束」：只留仍在运行/排队的行。 */
export function dropFinishedSubagents(list: readonly SubagentProgress[]): SubagentProgress[] {
  const next = list.filter((item) => !TERMINAL.has(item.status));
  return next.length === list.length ? (list as SubagentProgress[]) : next;
}

/** Drop synthetic delegate-tool fallback rows (used once native subagent.* events
 *  start arriving for a session, so the two paths don't double-count). */
export function pruneDelegateFallback(list: readonly SubagentProgress[]): SubagentProgress[] {
  const next = list.filter((item) => !item.id.startsWith("delegate-tool:"));
  return next.length === list.length ? (list as SubagentProgress[]) : next;
}

const firstString = (...candidates: unknown[]): string => {
  for (const v of candidates) {
    if (typeof v === "string" && v) return v;
  }
  return "";
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseMaybeRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value);
}

/** Synthesize subagent rows from a `delegate_task` tool event when the backend
 *  isn't emitting native subagent.* events. Ported from upstream
 *  use-message-stream.ts `delegateTaskPayloads`. */
export function delegateTaskPayloads(
  payload: SubagentPayload | undefined,
  phase: "running" | "complete",
  sourceEventType?: string,
): SubagentPayload[] {
  if (!payload || payload.name !== "delegate_task") return [];

  const args = parseMaybeRecord(payload.args ?? payload.input);
  const result = parseMaybeRecord(payload.result);
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
  const tasks = rawTasks.length ? rawTasks.map(parseMaybeRecord) : [args];
  const status: SubagentStatus = phase === "complete" ? (payload.error ? "failed" : "completed") : "running";
  const toolId = payload.tool_id || payload.tool_call_id || payload.id || "delegate_task";
  const progressText = firstString(payload.preview, payload.message, payload.context);

  const eventType =
    phase === "complete"
      ? "subagent.complete"
      : sourceEventType === "tool.start"
        ? "subagent.start"
        : "subagent.progress";

  return tasks.map((task, index) => {
    const goal = firstString(task.goal, args.goal, payload.context) || "Delegated task";
    const summary = firstString(result.summary, payload.summary, payload.message);
    return {
      depth: 0,
      duration_seconds: payload.duration_s,
      goal,
      status,
      subagent_id: `delegate-tool:${String(toolId)}:${index}`,
      summary: summary || undefined,
      task_count: tasks.length,
      task_index: index,
      text: eventType === "subagent.progress" ? progressText || goal : undefined,
      tool_name: eventType === "subagent.start" ? "delegate_task" : undefined,
      tool_preview: eventType === "subagent.start" ? progressText : undefined,
      toolsets: Array.isArray(task.toolsets) ? task.toolsets : Array.isArray(args.toolsets) ? args.toolsets : [],
      output_tail:
        phase === "complete" && summary
          ? [{ is_error: Boolean(payload.error), preview: summary, tool: "delegate_task" }]
          : undefined,
    } satisfies SubagentPayload;
  });
}

export function buildSubagentTree(items: readonly SubagentProgress[]): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>();
  for (const item of items) {
    nodes.set(item.id, { ...item, children: [] });
  }

  const roots: SubagentNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sort = (a: SubagentNode, b: SubagentNode) =>
    a.startedAt - b.startedAt || a.taskIndex - b.taskIndex || a.goal.localeCompare(b.goal);
  const walk = (node: SubagentNode) => node.children.sort(sort).forEach(walk);
  roots.sort(sort).forEach(walk);
  return roots;
}

export const flattenSubagents = (nodes: readonly SubagentNode[]): SubagentNode[] =>
  nodes.flatMap((node) => [node, ...flattenSubagents(node.children)]);

export const activeSubagentCount = (items: readonly SubagentProgress[]) =>
  items.filter((item) => item.status === "queued" || item.status === "running").length;

// ── Jotai state + gateway routing ───────────────────────────────────────────

export const subagentsBySessionAtom = atom<Record<string, SubagentProgress[]>>({});

// Renderer-global singleton: sessions that have emitted native subagent.* events.
// Once a session goes native we prune synthetic delegate-tool fallback rows and
// stop synthesizing them, so the two ingestion paths never double-count. Mirrors
// the upstream nativeSubagentSessionsRef. Survives for the window's lifetime;
// per-session keys never collide, so leaving stale entries is harmless.
const nativeSubagentSessions = new Set<string>();

/** Test-only: reset the native-session tracking between cases. */
export function __resetNativeSubagentSessions() {
  nativeSubagentSessions.clear();
}

/** Route a gateway event into the subagent store. Called from chat.ts's
 *  applyGatewayEventAtom (the single event funnel). Handles native subagent.*
 *  events, the delegate_task tool fallback, and per-turn clearing. */
export const routeSubagentGatewayEventAtom = atom(
  null,
  (_get, set, event: GatewayEvent, now: number = Date.now()) => {
    const sid = event.session_id;
    if (!sid) return;
    const type = event.type;
    const payload = (
      event.payload && typeof event.payload === "object" ? event.payload : {}
    ) as SubagentPayload;

    // 新回合不清空子代理树——与官方桌面端的有意分歧：已结束的子代理保留
    // 在面板里（状态图标标终态）方便 debug，上限 MAX_ITEMS，手动「清空已
    // 结束」删除。上一轮没收尾的行标 interrupted（原实现直接整树删除，
    // 跨回合事件同样无法复活它们）；native/fallback 判定仍按轮重置。
    if (type === "message.start") {
      nativeSubagentSessions.delete(sid);
      set(subagentsBySessionAtom, (state) => {
        const prevList = state[sid];
        if (!prevList?.length) return state;
        const next = markUnfinishedInterrupted(prevList);
        return next === prevList ? state : { ...state, [sid]: next };
      });
      return;
    }

    if (SUBAGENT_EVENT_TYPES.has(type)) {
      const firstNative = !nativeSubagentSessions.has(sid);
      nativeSubagentSessions.add(sid);
      const createIfMissing = type === "subagent.spawn_requested" || type === "subagent.start";
      set(subagentsBySessionAtom, (state) => {
        const prevList = state[sid] ?? [];
        const base = firstNative ? pruneDelegateFallback(prevList) : prevList;
        const next = reduceSubagentList(base, payload, createIfMissing, type, now);
        return next === prevList ? state : { ...state, [sid]: next };
      });
      return;
    }

    // Fallback: synthesize rows from the delegate_task tool lifecycle when the
    // backend isn't emitting native subagent.* events for this session.
    if (
      (type === "tool.start" || type === "tool.generating" || type === "tool.complete") &&
      payload.name === "delegate_task" &&
      !nativeSubagentSessions.has(sid)
    ) {
      const phase: "running" | "complete" = type === "tool.complete" ? "complete" : "running";
      const synth = delegateTaskPayloads(payload, phase, type);
      if (!synth.length) return;
      const eventType = phase === "complete" ? "delegate.complete" : "delegate.running";
      set(subagentsBySessionAtom, (state) => {
        let list = state[sid] ?? [];
        for (const p of synth) {
          list = reduceSubagentList(list, p, true, eventType, now);
        }
        return { ...state, [sid]: list };
      });
    }
  },
);

/** 面板「清空已结束」动作：对给到的候选会话 id 逐个清掉终态行。 */
export const clearFinishedSubagentsAtom = atom(
  null,
  (_get, set, sessionIds: (string | undefined)[]) => {
    set(subagentsBySessionAtom, (state) => {
      let next = state;
      let changed = false;
      for (const sid of sessionIds) {
        if (!sid) continue;
        const prevList = next[sid];
        if (!prevList?.length) continue;
        const filtered = dropFinishedSubagents(prevList);
        if (filtered !== prevList) {
          if (!changed) {
            next = { ...next };
            changed = true;
          }
          next[sid] = filtered;
        }
      }
      return next;
    });
  },
);
