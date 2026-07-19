import { atom } from "jotai";
import type { GatewayEvent } from "@hermes/protocol";

import {
  classifyCliDelegation,
  classifyFromContext,
  extractResult,
  resultFromWire,
  subEventFromWire,
  timelineFromOutput,
  type CliDelegationAgent,
  type CliDelegationResult,
  type CliDelegationSubEvent,
} from "../lib/cli-delegation";

// CLI 委派（Claude Code / Codex）监视状态。
//
// 数据来源两条路，事件源优先（Core P-047，tui_gateway/cli_delegation.py）：
//   delegation.cli.started / .output / .completed，delegation_id == tool_call_id。
// 旧内核回退：对 tool.start 的 context 做临时判定（80 字符截断，宽松），
// tool.complete 的全量 args.command 做权威确认——不命中即删临时条目；
// 后台委派旧内核不跟踪，诚实标注 detached。
//
// 与 subagents.ts 不同：委派**不随 message.start 清空**——后台委派跨回合
// 存续是特性（codex exec --full-auto 可能跑十几分钟）。每会话 cap 20 条。

export type CliDelegationStatus = "running" | "completed" | "failed" | "killed" | "lost" | "detached";
export type CliDelegationOrigin = "events" | "fallback";
export type CliDelegationExecution = "foreground" | "background";

export interface CliDelegationEntry {
  id: string; // delegation_id == tool_call_id
  agent: CliDelegationAgent;
  origin: CliDelegationOrigin;
  execution: CliDelegationExecution;
  status: CliDelegationStatus;
  mode?: string;
  promptExcerpt: string;
  command?: string;
  workdir?: string | null;
  flags?: Record<string, unknown>;
  startedAt: number;
  completedAt?: number;
  durationS?: number;
  exitCode?: number | null;
  outputTail: string;
  timeline: CliDelegationSubEvent[];
  result?: CliDelegationResult;
  truncated?: boolean;
}

const MAX_ENTRIES_PER_SESSION = 20;
const OUTPUT_TAIL_CAP = 8000;
const TIMELINE_CAP = 200;

const TERMINAL_STATUSES: ReadonlySet<CliDelegationStatus> = new Set([
  "completed", "failed", "killed", "lost",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const numOrUndef = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const asAgent = (v: unknown): CliDelegationAgent | null =>
  v === "claude-code" || v === "codex" ? v : null;

const asStatus = (v: unknown): CliDelegationStatus =>
  v === "completed" || v === "failed" || v === "killed" || v === "lost" || v === "detached"
    ? v
    : "completed";

const asExecution = (v: unknown): CliDelegationExecution =>
  v === "background" ? "background" : "foreground";

const appendTail = (tail: string, chunk: string) => {
  if (!chunk) return tail;
  const next = tail + chunk;
  return next.length > OUTPUT_TAIL_CAP ? next.slice(-OUTPUT_TAIL_CAP) : next;
};

const appendTimeline = (
  timeline: CliDelegationSubEvent[],
  events: CliDelegationSubEvent[],
): CliDelegationSubEvent[] => {
  if (!events.length) return timeline;
  return [...timeline, ...events].slice(-TIMELINE_CAP);
};

const capList = (list: CliDelegationEntry[]): CliDelegationEntry[] =>
  list.length > MAX_ENTRIES_PER_SESSION ? list.slice(-MAX_ENTRIES_PER_SESSION) : list;

const upsert = (
  list: CliDelegationEntry[],
  entry: CliDelegationEntry,
): CliDelegationEntry[] => {
  const idx = list.findIndex((item) => item.id === entry.id);
  return idx >= 0 ? list.map((item) => (item.id === entry.id ? entry : item)) : capList([...list, entry]);
};

// ── 纯 reducer（全部导出供单测） ──────────────────────────────────────────

export function applyStarted(
  list: CliDelegationEntry[],
  payload: Record<string, unknown>,
  now: number,
): CliDelegationEntry[] {
  const id = str(payload.delegation_id) || str(payload.tool_id);
  const agent = asAgent(payload.agent);
  if (!id || !agent) return list;
  const prev = list.find((item) => item.id === id);
  const entry: CliDelegationEntry = {
    id,
    agent,
    origin: "events",
    execution: asExecution(payload.execution),
    status: "running",
    mode: str(payload.mode) || prev?.mode,
    promptExcerpt: str(payload.prompt_excerpt) || prev?.promptExcerpt || "",
    command: str(payload.command_redacted) || prev?.command,
    workdir: typeof payload.workdir === "string" ? payload.workdir : (prev?.workdir ?? null),
    flags: isRecord(payload.flags) ? payload.flags : prev?.flags,
    startedAt: prev?.startedAt ?? now,
    outputTail: prev?.outputTail ?? "",
    timeline: prev?.timeline ?? [],
  };
  return upsert(list, entry);
}

export function applyOutput(
  list: CliDelegationEntry[],
  payload: Record<string, unknown>,
): CliDelegationEntry[] {
  const id = str(payload.delegation_id);
  if (!id) return list;
  const idx = list.findIndex((item) => item.id === id);
  if (idx < 0) return list;
  const prev = list[idx]!;
  if (TERMINAL_STATUSES.has(prev.status)) return list;
  const wireEvents = Array.isArray(payload.events)
    ? payload.events.map(subEventFromWire).filter((e): e is CliDelegationSubEvent => e !== null)
    : [];
  const next: CliDelegationEntry = {
    ...prev,
    outputTail: appendTail(prev.outputTail, str(payload.chunk)),
    timeline: appendTimeline(prev.timeline, wireEvents),
    truncated: payload.truncated === true ? true : prev.truncated,
  };
  return list.map((item) => (item.id === id ? next : item));
}

export function applyCompleted(
  list: CliDelegationEntry[],
  payload: Record<string, unknown>,
  now: number,
): CliDelegationEntry[] {
  const id = str(payload.delegation_id);
  if (!id) return list;
  const idx = list.findIndex((item) => item.id === id);
  if (idx < 0) return list;
  const prev = list[idx]!;
  const outputTail = str(payload.output_tail);
  const next: CliDelegationEntry = {
    ...prev,
    status: asStatus(payload.status),
    completedAt: now,
    durationS: numOrUndef(payload.duration_s) ?? prev.durationS,
    exitCode:
      typeof payload.exit_code === "number" ? payload.exit_code : payload.exit_code === null ? null : prev.exitCode,
    outputTail: outputTail || prev.outputTail,
    result: resultFromWire(payload.result) ?? prev.result,
    timeline:
      prev.timeline.length === 0 && outputTail
        ? timelineFromOutput(prev.agent, outputTail, TIMELINE_CAP)
        : prev.timeline,
  };
  return list.map((item) => (item.id === id ? next : item));
}

/** 旧内核回退：tool.start 的截断 context 临时判定。 */
export function applyFallbackToolStart(
  list: CliDelegationEntry[],
  payload: Record<string, unknown>,
  now: number,
): CliDelegationEntry[] {
  if (payload.name !== "terminal") return list;
  const id = str(payload.tool_id);
  if (!id) return list;
  const spec = classifyFromContext(str(payload.context) || undefined);
  if (!spec) return list;
  if (list.some((item) => item.id === id)) return list;
  const entry: CliDelegationEntry = {
    id,
    agent: spec.agent,
    origin: "fallback",
    execution: spec.flags.background ? "background" : "foreground",
    status: "running",
    mode: spec.mode,
    promptExcerpt: spec.promptExcerpt,
    workdir: spec.workdir,
    flags: spec.flags,
    startedAt: now,
    outputTail: "",
    timeline: [],
  };
  return capList([...list, entry]);
}

const FAILURE_STATUSES = new Set(["error", "blocked", "disabled", "pending_approval"]);

/** 旧内核回退：tool.complete 的全量 args.command 权威确认与终态。 */
export function applyFallbackToolComplete(
  list: CliDelegationEntry[],
  payload: Record<string, unknown>,
  now: number,
): CliDelegationEntry[] {
  if (payload.name !== "terminal") return list;
  const id = str(payload.tool_id);
  if (!id) return list;
  const idx = list.findIndex((item) => item.id === id);
  const prev = idx >= 0 ? list[idx]! : undefined;
  if (prev && prev.origin === "events") return list; // 事件源不被回退降级

  const args = isRecord(payload.args) ? payload.args : undefined;
  const command = args ? str(args.command) : "";
  const spec = command ? classifyCliDelegation(command, args) : null;

  if (!spec) {
    // 权威判定不是委派：临时条目是误报，删除；本就没有条目则不动。
    return prev ? list.filter((item) => item.id !== id) : list;
  }

  const result = isRecord(payload.result) ? payload.result : undefined;
  const output = result ? str(result.output) : "";
  const exitCode = result && typeof result.exit_code === "number" ? result.exit_code : undefined;
  const failed =
    FAILURE_STATUSES.has(str(result?.status)) ||
    Boolean(result?.error) ||
    (exitCode !== undefined && exitCode !== 0);

  const background = Boolean(spec.flags.background);
  const status: CliDelegationStatus = background
    ? failed
      ? "failed"
      : "detached" // 旧内核不跟踪后台进程，诚实标注
    : failed
      ? "failed"
      : "completed";

  const entry: CliDelegationEntry = {
    id,
    agent: spec.agent,
    origin: "fallback",
    execution: background ? "background" : "foreground",
    status,
    mode: spec.mode,
    promptExcerpt: spec.promptExcerpt || prev?.promptExcerpt || "",
    command,
    workdir: spec.workdir ?? prev?.workdir ?? null,
    flags: spec.flags,
    startedAt: prev?.startedAt ?? now,
    completedAt: background && !failed ? undefined : now,
    durationS: numOrUndef(payload.duration_s),
    exitCode: exitCode ?? null,
    outputTail: background ? "" : output.slice(-OUTPUT_TAIL_CAP),
    timeline: background ? [] : timelineFromOutput(spec.agent, output, TIMELINE_CAP),
    result: background ? undefined : extractResult(spec.agent, output),
  };
  return prev ? list.map((item) => (item.id === id ? entry : item)) : capList([...list, entry]);
}

// ── 历史重载恢复 ─────────────────────────────────────────────────────────

/** 从历史消息的 tool part（input=args, output=result）恢复已完成的委派条目。
 *  实时 store 不落盘，重载后由 message-timeline 在渲染路径调用本函数按需重建。 */
export function entryFromHistoryToolPart(part: {
  toolCallId: string;
  name: string;
  input?: unknown;
  output?: unknown;
  state: string;
  startedAt?: number;
  completedAt?: number;
}): CliDelegationEntry | null {
  if (part.name !== "terminal") return null;
  const args = isRecord(part.input) ? part.input : undefined;
  const command = args ? str(args.command) : "";
  if (!command) return null;
  const spec = classifyCliDelegation(command, args);
  if (!spec) return null;

  const output = isRecord(part.output) ? str((part.output as Record<string, unknown>).output) : str(part.output);
  const background = Boolean(spec.flags.background);
  const status: CliDelegationStatus =
    part.state === "error" ? "failed" : part.state === "running" ? "running" : background ? "detached" : "completed";
  return {
    id: part.toolCallId,
    agent: spec.agent,
    origin: "fallback",
    execution: background ? "background" : "foreground",
    status,
    mode: spec.mode,
    promptExcerpt: spec.promptExcerpt,
    command,
    workdir: spec.workdir,
    flags: spec.flags,
    startedAt: part.startedAt ?? 0,
    completedAt: part.completedAt,
    outputTail: background ? "" : output.slice(-OUTPUT_TAIL_CAP),
    timeline: background ? [] : timelineFromOutput(spec.agent, output, TIMELINE_CAP),
    result: background || !output ? undefined : extractResult(spec.agent, output),
  };
}

export const activeCliDelegationCount = (items: readonly CliDelegationEntry[]) =>
  items.filter((item) => item.status === "running").length;

/** 面板「清空已结束」：只留仍在运行的委派（detached 视为已结束，可清）。 */
export function dropFinishedCliDelegations(list: readonly CliDelegationEntry[]): CliDelegationEntry[] {
  const next = list.filter((item) => item.status === "running");
  return next.length === list.length ? (list as CliDelegationEntry[]) : next;
}

// ── Jotai state + gateway routing ───────────────────────────────────────────

export const cliDelegationsBySessionAtom = atom<Record<string, CliDelegationEntry[]>>({});

/** tool_call_id → 条目的全局索引（tool_call_id 全局唯一，跨会话不冲突）。
 *  聊天时间线据此把 terminal 工具卡升级为委派卡，无需向下传 sessionId。 */
export const cliDelegationsByToolIdAtom = atom((get) => {
  const map = new Map<string, CliDelegationEntry>();
  for (const list of Object.values(get(cliDelegationsBySessionAtom))) {
    for (const entry of list) map.set(entry.id, entry);
  }
  return map;
});

// Renderer 级单例：已发出原生 delegation.cli.* 事件的会话。原生会话跳过回退
// 合成，避免双路径重复计数。镜像 subagents.ts 的 nativeSubagentSessions 手法。
const nativeCliSessions = new Set<string>();

/** Test-only: reset the native-session tracking between cases. */
export function __resetNativeCliSessions() {
  nativeCliSessions.clear();
}

const CLI_DELEGATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "delegation.cli.started",
  "delegation.cli.output",
  "delegation.cli.completed",
]);

/** Route a gateway event into the CLI delegation store. Called from chat.ts's
 *  applyGatewayEventAtom (the single event funnel), right after the subagent
 *  routing. 注意不随 message.start 清空（后台委派跨回合存续）。 */
export const routeCliDelegationGatewayEventAtom = atom(
  null,
  (_get, set, event: GatewayEvent, now: number = Date.now()) => {
    const sid = event.session_id;
    if (!sid) return;
    const type = event.type;
    const payload = (
      event.payload && typeof event.payload === "object" ? event.payload : {}
    ) as Record<string, unknown>;

    if (CLI_DELEGATION_EVENT_TYPES.has(type)) {
      nativeCliSessions.add(sid);
      set(cliDelegationsBySessionAtom, (state) => {
        const prevList = state[sid] ?? [];
        let next = prevList;
        if (type === "delegation.cli.started") next = applyStarted(prevList, payload, now);
        else if (type === "delegation.cli.output") next = applyOutput(prevList, payload);
        else next = applyCompleted(prevList, payload, now);
        return next === prevList ? state : { ...state, [sid]: next };
      });
      return;
    }

    if (nativeCliSessions.has(sid)) return;
    if (type !== "tool.start" && type !== "tool.complete") return;
    if (payload.name !== "terminal") return;

    set(cliDelegationsBySessionAtom, (state) => {
      const prevList = state[sid] ?? [];
      const next =
        type === "tool.start"
          ? applyFallbackToolStart(prevList, payload, now)
          : applyFallbackToolComplete(prevList, payload, now);
      return next === prevList ? state : { ...state, [sid]: next };
    });
  },
);

/** 面板「清空已结束」动作：对给到的候选会话 id 逐个清掉终态/未跟踪的委派。 */
export const clearFinishedCliDelegationsAtom = atom(
  null,
  (_get, set, sessionIds: (string | undefined)[]) => {
    set(cliDelegationsBySessionAtom, (state) => {
      let next = state;
      let changed = false;
      for (const sid of sessionIds) {
        if (!sid) continue;
        const prevList = next[sid];
        if (!prevList?.length) continue;
        const filtered = dropFinishedCliDelegations(prevList);
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
