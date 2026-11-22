// 回合身份（turn_id）：把「同一回合还是新回合」从启发式改成后端权威。
//
// 此前网关事件只带 type + session_id，reducer 只能靠 activeAssistantId 指针 +
// streamStatus 猜回合边界。于是重复的 message.start（Core 有 5 处调用点在
// _run_prompt_submit 之前预先 emit 一次，它自己又 emit 一次）或重连重放看起来
// 就跟新回合一模一样，一条回复被拆成两个气泡。
//
// Core 现在给一个回合的每个事件都盖上同一个 turn_id。关键契约：
//   turn_id 相同   → 同一回合，追加
//   turn_id 不同   → 新回合，新气泡
//   turn_id 缺失   → 旧 Core，退回原有 activeAssistantId 启发式（绝不能当成同一回合）
import { describe, expect, it } from "vitest";
import type { GatewayEvent } from "@hermes/protocol";

import { createEmptyChatRuntime, reduceGatewayEvent } from "./chat";

const SID = "sess-turn-id";
const T1 = "turn_aaaa1111bbbb2222";
const T2 = "turn_cccc3333dddd4444";

function ev(type: string, turnId?: string, payload?: unknown): GatewayEvent {
  return {
    type,
    session_id: SID,
    ...(turnId ? { turn_id: turnId } : {}),
    ...(payload !== undefined ? { payload } : {}),
  } as GatewayEvent;
}

function assistants(runtime: ReturnType<typeof createEmptyChatRuntime>) {
  return runtime.messages.filter((m) => m.role === "assistant");
}

describe("turn_id：同一回合", () => {
  it("重复的 message.start 带同一个 turn_id 时是幂等的，不新建气泡", () => {
    let runtime = createEmptyChatRuntime(1_000);
    // Core 预先 emit 一次，_run_prompt_submit 自己又 emit 一次。
    runtime = reduceGatewayEvent(runtime, ev("message.start", T1), 1_000);
    const firstId = runtime.activeAssistantId;
    runtime = reduceGatewayEvent(runtime, ev("message.start", T1), 1_050);

    expect(assistants(runtime)).toHaveLength(1);
    expect(runtime.activeAssistantId).toBe(firstId);
    expect(runtime.activeTurnId).toBe(T1);
  });

  it("即使 streamStatus 已不是 streaming，同一 turn_id 仍然续用同一气泡", () => {
    let runtime = createEmptyChatRuntime(1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.start", T1), 1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.delta", T1, { text: "答案" }), 1_100);
    const bubbleId = runtime.activeAssistantId;

    // 人为把状态改成非流式（模拟旧启发式会误判为「新回合」的时刻）。
    runtime = { ...runtime, streamStatus: "complete" };
    runtime = reduceGatewayEvent(runtime, ev("message.start", T1), 1_200);

    // turn_id 权威：仍是同一条。
    expect(assistants(runtime)).toHaveLength(1);
    expect(runtime.activeAssistantId).toBe(bubbleId);
  });
});

describe("turn_id：新回合", () => {
  it("turn_id 变化时开新气泡", () => {
    let runtime = createEmptyChatRuntime(1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.start", T1), 1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.delta", T1, { text: "第一回合" }), 1_100);
    runtime = reduceGatewayEvent(
      runtime,
      ev("message.complete", T1, { text: "第一回合" }),
      1_200,
    );

    runtime = reduceGatewayEvent(runtime, ev("message.start", T2), 2_000);
    runtime = reduceGatewayEvent(runtime, ev("message.delta", T2, { text: "第二回合" }), 2_100);

    expect(assistants(runtime)).toHaveLength(2);
    expect(runtime.activeTurnId).toBe(T2);
  });

  it("新回合重置 turnStartedAt，不沿用上一回合的开始时间", () => {
    let runtime = createEmptyChatRuntime(1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.start", T1), 1_000);
    expect(runtime.turnStartedAt).toBe(1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.complete", T1, { text: "x" }), 1_500);

    runtime = reduceGatewayEvent(runtime, ev("message.start", T2), 9_000);

    // 旧代码这里会是 1_000（turnStartedAt ?? now 无条件沿用），把后续每个
    // 回合的计时都回填到第一个回合。
    expect(runtime.turnStartedAt).toBe(9_000);
  });

  it("回合收尾后清掉 activeTurnId，陈旧 id 不会误配后续回合", () => {
    let runtime = createEmptyChatRuntime(1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.start", T1), 1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.delta", T1, { text: "x" }), 1_100);
    runtime = reduceGatewayEvent(runtime, ev("message.complete", T1, { text: "x" }), 1_200);

    expect(runtime.activeTurnId).toBeUndefined();
    expect(runtime.activeAssistantId).toBeUndefined();
  });
});

describe("向后兼容：旧 Core 不发 turn_id", () => {
  it("无 turn_id 时退回原有启发式：流式中续用同一气泡", () => {
    let runtime = createEmptyChatRuntime(1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.start"), 1_000);
    const bubbleId = runtime.activeAssistantId;
    runtime = reduceGatewayEvent(runtime, ev("message.delta", undefined, { text: "hi" }), 1_100);
    // 旧行为：流式中重复 start 复用同一气泡。
    runtime = reduceGatewayEvent(runtime, ev("message.start"), 1_150);

    expect(assistants(runtime)).toHaveLength(1);
    expect(runtime.activeAssistantId).toBe(bubbleId);
    expect(runtime.activeTurnId).toBeUndefined();
  });

  it("无 turn_id 且上一回合已收尾时开新气泡（不把缺失当成同一回合）", () => {
    let runtime = createEmptyChatRuntime(1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.start"), 1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.delta", undefined, { text: "一" }), 1_100);
    runtime = reduceGatewayEvent(runtime, ev("message.complete", undefined, { text: "一" }), 1_200);

    runtime = reduceGatewayEvent(runtime, ev("message.start"), 2_000);
    runtime = reduceGatewayEvent(runtime, ev("message.delta", undefined, { text: "二" }), 2_100);

    expect(assistants(runtime)).toHaveLength(2);
  });
});

describe("新旧混搭（升级中途的真实形态）", () => {
  it("回合中途才开始带 turn_id：采纳它，不另起气泡", () => {
    let runtime = createEmptyChatRuntime(1_000);
    // 先来一个没有 turn_id 的 start（例如旧路径 / 预先 emit）。
    runtime = reduceGatewayEvent(runtime, ev("message.start"), 1_000);
    const bubbleId = runtime.activeAssistantId;
    // 随后同一回合的事件带上了 turn_id。
    runtime = reduceGatewayEvent(runtime, ev("message.start", T1), 1_050);

    expect(assistants(runtime)).toHaveLength(1);
    expect(runtime.activeAssistantId).toBe(bubbleId);
    expect(runtime.activeTurnId).toBe(T1);
  });

  it("带 turn_id 的回合后面跟一个不带的 start：不误判为同一回合", () => {
    let runtime = createEmptyChatRuntime(1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.start", T1), 1_000);
    runtime = reduceGatewayEvent(runtime, ev("message.delta", T1, { text: "一" }), 1_100);
    runtime = reduceGatewayEvent(runtime, ev("message.complete", T1, { text: "一" }), 1_200);

    // 收尾已清掉 activeTurnId，缺失 → 退回启发式 → 非流式 → 新气泡。
    runtime = reduceGatewayEvent(runtime, ev("message.start"), 2_000);
    runtime = reduceGatewayEvent(runtime, ev("message.delta", undefined, { text: "二" }), 2_100);

    expect(assistants(runtime)).toHaveLength(2);
  });
});
