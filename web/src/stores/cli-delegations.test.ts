import { createStore } from "jotai";
import { afterEach, describe, expect, it } from "vitest";

import type { GatewayEvent } from "@hermes/protocol";

import {
  __resetNativeCliSessions,
  activeCliDelegationCount,
  cliDelegationsBySessionAtom,
  entryFromHistoryToolPart,
  routeCliDelegationGatewayEventAtom,
} from "./cli-delegations";

const SID = "sess-1";

const ev = (type: string, payload: Record<string, unknown>): GatewayEvent =>
  ({ type, session_id: SID, payload }) as GatewayEvent;

const resultLine =
  '{"type":"result","subtype":"success","session_id":"cc-1","num_turns":3,"total_cost_usd":0.02,"is_error":false}';

function makeStore() {
  const store = createStore();
  const route = (event: GatewayEvent, now = 1000) =>
    store.set(routeCliDelegationGatewayEventAtom, event, now);
  const list = () => store.get(cliDelegationsBySessionAtom)[SID] ?? [];
  return { route, list };
}

afterEach(() => {
  __resetNativeCliSessions();
});

describe("事件源路径（新内核 delegation.cli.*）", () => {
  it("started → output → completed 全链路", () => {
    const { route, list } = makeStore();
    route(
      ev("delegation.cli.started", {
        delegation_id: "call-1",
        tool_id: "call-1",
        agent: "claude-code",
        mode: "print",
        execution: "background",
        command_redacted: "claude -p 'Summarize' --output-format stream-json",
        prompt_excerpt: "Summarize",
        workdir: "/repo",
        flags: { background: true, output_format: "stream-json" },
      }),
    );
    expect(list()).toHaveLength(1);
    expect(list()[0]).toMatchObject({
      id: "call-1",
      agent: "claude-code",
      origin: "events",
      execution: "background",
      status: "running",
      promptExcerpt: "Summarize",
      workdir: "/repo",
    });

    route(
      ev("delegation.cli.output", {
        delegation_id: "call-1",
        chunk: "hello ",
        truncated: false,
        events: [{ kind: "text", text: "hello" }],
      }),
    );
    route(
      ev("delegation.cli.output", {
        delegation_id: "call-1",
        chunk: "world",
        truncated: false,
        events: [{ kind: "tool_use", tool_name: "Bash" }],
      }),
    );
    expect(list()[0]!.outputTail).toBe("hello world");
    expect(list()[0]!.timeline).toEqual([
      { kind: "text", text: "hello" },
      expect.objectContaining({ kind: "tool_use", toolName: "Bash" }),
    ]);

    route(
      ev("delegation.cli.completed", {
        delegation_id: "call-1",
        agent: "claude-code",
        execution: "background",
        status: "completed",
        exit_code: 0,
        duration_s: 12.5,
        output_tail: "final tail",
        result: { session_id: "cc-1", num_turns: 3, total_cost_usd: 0.02 },
      }),
      2000,
    );
    expect(list()[0]).toMatchObject({
      status: "completed",
      exitCode: 0,
      durationS: 12.5,
      outputTail: "final tail",
      completedAt: 2000,
      result: { sessionId: "cc-1", numTurns: 3, totalCostUsd: 0.02 },
    });
  });

  it("started 升级同 id 的 fallback 临时条目并保留 startedAt", () => {
    const { route, list } = makeStore();
    route(
      ev("tool.start", { tool_id: "call-2", name: "terminal", context: "Running claude -p 'do it'" }),
      500,
    );
    expect(list()[0]).toMatchObject({ id: "call-2", origin: "fallback", startedAt: 500 });

    route(
      ev("delegation.cli.started", {
        delegation_id: "call-2",
        agent: "claude-code",
        mode: "print",
        execution: "foreground",
        prompt_excerpt: "do it",
      }),
      600,
    );
    expect(list()).toHaveLength(1);
    expect(list()[0]).toMatchObject({ origin: "events", startedAt: 500, promptExcerpt: "do it" });
  });

  it("原生会话跳过 tool.complete 回退合成", () => {
    const { route, list } = makeStore();
    route(ev("delegation.cli.started", { delegation_id: "call-3", agent: "codex", execution: "foreground" }));
    route(
      ev("tool.complete", {
        tool_id: "call-3",
        name: "terminal",
        args: { command: "codex exec 'x'" },
        result: { output: "done", exit_code: 0 },
      }),
    );
    // 回退路径没跑：状态仍是 running（等 delegation.cli.completed）。
    expect(list()[0]!.status).toBe("running");
  });
});

describe("回退路径（旧内核）", () => {
  it("前台：tool.start 临时判定 → tool.complete 权威终态并解析 stream-json", () => {
    const { route, list } = makeStore();
    route(
      ev("tool.start", {
        tool_id: "call-4",
        name: "terminal",
        context: "Running claude -p 'Analyze auth.py' --output-format st",
      }),
    );
    expect(list()[0]).toMatchObject({ status: "running", origin: "fallback", agent: "claude-code" });

    route(
      ev("tool.complete", {
        tool_id: "call-4",
        name: "terminal",
        duration_s: 8.2,
        args: { command: "claude -p 'Analyze auth.py' --output-format stream-json --verbose" },
        result: { output: `{"type":"system","subtype":"init","session_id":"cc-1"}\n${resultLine}`, exit_code: 0 },
      }),
    );
    expect(list()[0]).toMatchObject({
      status: "completed",
      durationS: 8.2,
      exitCode: 0,
      result: expect.objectContaining({ sessionId: "cc-1", numTurns: 3 }),
    });
    expect(list()[0]!.timeline.some((e) => e.kind === "result")).toBe(true);
  });

  it("误报删除：complete 的全量命令判定不是委派", () => {
    const { route, list } = makeStore();
    route(
      ev("tool.start", { tool_id: "call-5", name: "terminal", context: "Running claude --version" }),
    );
    // context 截断可能导致临时误判——这里手工构造一个更极端的：context 判成委派
    route(
      ev("tool.start", { tool_id: "call-5b", name: "terminal", context: "Running claude -p x" }),
    );
    route(
      ev("tool.complete", {
        tool_id: "call-5b",
        name: "terminal",
        args: { command: "claude --version" },
        result: { output: "2.1.212", exit_code: 0 },
      }),
    );
    expect(list().some((item) => item.id === "call-5b")).toBe(false);
  });

  it("后台委派标 detached（旧内核不跟踪）", () => {
    const { route, list } = makeStore();
    route(
      ev("tool.complete", {
        tool_id: "call-6",
        name: "terminal",
        args: { command: "codex exec --full-auto 'refactor'", background: true, pty: true },
        result: { output: "Background process started", session_id: "proc_1", exit_code: 0 },
      }),
    );
    expect(list()[0]).toMatchObject({ status: "detached", execution: "background", agent: "codex" });
    expect(activeCliDelegationCount(list())).toBe(0);
  });

  it("无 tool.start 时 complete 直接落成完成态；失败映射 failed", () => {
    const { route, list } = makeStore();
    route(
      ev("tool.complete", {
        tool_id: "call-7",
        name: "terminal",
        args: { command: "claude -p 'quick'" },
        result: { output: "boom", exit_code: 1, error: "exit 1" },
      }),
    );
    expect(list()[0]).toMatchObject({ status: "failed", exitCode: 1 });
  });

  it("message.start 不清空（后台委派跨回合存续）", () => {
    const { route, list } = makeStore();
    route(
      ev("tool.complete", {
        tool_id: "call-8",
        name: "terminal",
        args: { command: "codex exec 'x'", background: true },
        result: { output: "Background process started", session_id: "proc_2", exit_code: 0 },
      }),
    );
    route(ev("message.start", {}));
    expect(list()).toHaveLength(1);
  });

  it("每会话 cap 20 条", () => {
    const { route, list } = makeStore();
    for (let i = 0; i < 25; i += 1) {
      route(
        ev("tool.complete", {
          tool_id: `call-cap-${i}`,
          name: "terminal",
          args: { command: `claude -p 'task ${i}'` },
          result: { output: "ok", exit_code: 0 },
        }),
      );
    }
    expect(list()).toHaveLength(20);
    expect(list()[0]!.id).toBe("call-cap-5");
  });
});

describe("历史重载恢复", () => {
  it("terminal + 委派命令 + stream-json 输出 → 完成态条目", () => {
    const entry = entryFromHistoryToolPart({
      toolCallId: "hist-1",
      name: "terminal",
      state: "done",
      input: { command: "claude -p 'Analyze' --output-format stream-json" },
      output: { output: resultLine, exit_code: 0 },
      startedAt: 100,
      completedAt: 200,
    });
    expect(entry).toMatchObject({
      id: "hist-1",
      agent: "claude-code",
      status: "completed",
      result: expect.objectContaining({ sessionId: "cc-1" }),
    });
  });

  it("非委派或非 terminal → null", () => {
    expect(
      entryFromHistoryToolPart({ toolCallId: "h2", name: "terminal", state: "done", input: { command: "ls" } }),
    ).toBeNull();
    expect(
      entryFromHistoryToolPart({ toolCallId: "h3", name: "read_file", state: "done", input: { path: "/x" } }),
    ).toBeNull();
  });

  it("后台委派历史 → detached", () => {
    const entry = entryFromHistoryToolPart({
      toolCallId: "h4",
      name: "terminal",
      state: "done",
      input: { command: "codex exec --json 'x'", background: true },
      output: { output: "Background process started", session_id: "proc_9" },
    });
    expect(entry).toMatchObject({ status: "detached", execution: "background" });
  });
});
