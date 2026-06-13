import { beforeEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "@hermes/protocol";
import { createEmptyChatRuntime } from "@/stores/chat";
import { __resetUiStoreForTests } from "@/lib/ui-store";
import { rememberSessionMapping } from "@/lib/session-map";
import {
  STALL_WATCHDOG_THRESHOLD_MS,
  isRuntimeRunning,
  isSessionRunning,
  mergeLiveRuntimeSessions,
  sessionIdMatches,
  streamSilenceMs,
} from "./session-activity";
import type { ChatSessionRuntime } from "@/stores/chat";

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s1",
    source: "tui",
    user_id: null,
    model: "test-model",
    title: null,
    started_at: 1,
    ended_at: null,
    message_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
    ...overrides,
  } as SessionSummary;
}

describe("session activity", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
  });

  it("does not treat completed recent sessions as running", () => {
    expect(
      isSessionRunning(
        session({
          is_active: true,
          message_count: 2,
        }),
      ),
    ).toBe(false);
  });

  it("keeps empty active sessions in running state as a first-turn fallback", () => {
    expect(
      isSessionRunning(
        session({
          is_active: true,
          message_count: 0,
        }),
      ),
    ).toBe(true);
  });

  it("uses live runtime state over the API active heuristic", () => {
    const completeRuntime = {
      ...createEmptyChatRuntime(1),
      streamStatus: "complete" as const,
    };
    const streamingRuntime = {
      ...createEmptyChatRuntime(1),
      streamStatus: "streaming" as const,
    };

    expect(
      isSessionRunning(
        session({ is_active: true, message_count: 0 }),
        { s1: completeRuntime },
      ),
    ).toBe(false);
    expect(isRuntimeRunning(streamingRuntime)).toBe(true);
    expect(
      isSessionRunning(
        session({ is_active: false, message_count: 2 }),
        { s1: streamingRuntime },
      ),
    ).toBe(true);
  });

  it("does not keep completed or errored runtimes running because of stale live parts", () => {
    const runtime = {
      ...createEmptyChatRuntime(1),
      streamStatus: "complete" as const,
      pendingApprovals: [{ requestId: "r1", sessionId: "s1", command: "approve" }],
      messages: [
        {
          id: "a1",
          sessionId: "s1",
          role: "assistant" as const,
          createdAt: 1,
          status: "complete" as const,
          parts: [
            {
              type: "tool" as const,
              toolCallId: "tool-1",
              name: "read_file",
              state: "running" as const,
            },
          ],
        },
      ],
    };

    expect(isRuntimeRunning(runtime)).toBe(false);
    expect(isRuntimeRunning({ ...runtime, streamStatus: "error" })).toBe(false);
  });

  it("adds a running gateway-only session while the REST list has not caught up", () => {
    const now = 1_700_000_000_000;
    const sessions = mergeLiveRuntimeSessions([], {
      "gw-1": {
        ...createEmptyChatRuntime(now),
        streamStatus: "streaming",
        turnStartedAt: now,
        messages: [
          {
            id: "u1",
            sessionId: "gw-1",
            role: "user",
            createdAt: now,
            status: "complete",
            parts: [{ type: "text", text: " 分析一下这个项目\n\n的架构 " }],
          },
          {
            id: "a1",
            sessionId: "gw-1",
            role: "assistant",
            createdAt: now,
            status: "streaming",
            parts: [{ type: "progress", text: "正在启动Hermes Agent内核..." }],
          },
        ],
      },
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("gw-1");
    expect(sessions[0]?.preview).toBe("分析一下这个项目 的架构");
    expect(sessions[0]?.started_at).toBe(1_700_000_000);
    expect(isSessionRunning(sessions[0]!, {
      "gw-1": {
        ...createEmptyChatRuntime(now),
        streamStatus: "streaming",
      },
    })).toBe(true);
  });

  it("does not duplicate a gateway runtime once it is mapped to a persistent session", () => {
    rememberSessionMapping("gw-1", "persist-1");
    const apiSession = session({
      id: "persist-1",
      is_active: false,
      message_count: 2,
    });
    const runtime = {
      ...createEmptyChatRuntime(1_700_000_000_000),
      streamStatus: "streaming" as const,
    };

    const sessions = mergeLiveRuntimeSessions([apiSession], { "gw-1": runtime });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("persist-1");
    expect(isSessionRunning(sessions[0]!, { "gw-1": runtime })).toBe(true);
    expect(sessionIdMatches("persist-1", "gw-1")).toBe(true);
  });
});

describe("streamSilenceMs (stall watchdog input)", () => {
  function runningRuntime(overrides: Partial<ChatSessionRuntime> = {}): ChatSessionRuntime {
    return {
      ...createEmptyChatRuntime(0),
      streamStatus: "streaming",
      ...overrides,
    };
  }

  it("returns null when the turn is not running", () => {
    const idle = createEmptyChatRuntime(0); // streamStatus "idle"
    expect(streamSilenceMs(idle, 10_000)).toBeNull();
    expect(streamSilenceMs(undefined, 10_000)).toBeNull();
  });

  it("measures elapsed since the last backend activity while running", () => {
    const runtime = runningRuntime({ lastActivityAt: 1_000, turnStartedAt: 500 });
    expect(streamSilenceMs(runtime, 4_000)).toBe(3_000);
  });

  it("pauses while waiting on a pending approval (not a stall)", () => {
    const runtime = runningRuntime({
      lastActivityAt: 1_000,
      pendingApprovals: [
        { requestId: "r1", sessionId: "s1", command: "ls" },
      ],
    });
    expect(streamSilenceMs(runtime, 999_000)).toBeNull();
  });

  it("falls back to turnStartedAt when no activity has been recorded yet", () => {
    const runtime = runningRuntime({ lastActivityAt: undefined, turnStartedAt: 2_000 });
    expect(streamSilenceMs(runtime, 5_000)).toBe(3_000);
  });

  it("never reports negative silence for clock skew", () => {
    const runtime = runningRuntime({ lastActivityAt: 10_000 });
    expect(streamSilenceMs(runtime, 1_000)).toBe(0);
  });

  it("exposes a generous default threshold", () => {
    // A sanity bound: long enough to outlast normal pre-first-token thinking,
    // short enough to be useful. Keep it in the tens-of-seconds range.
    expect(STALL_WATCHDOG_THRESHOLD_MS).toBeGreaterThanOrEqual(30_000);
    expect(STALL_WATCHDOG_THRESHOLD_MS).toBeLessThanOrEqual(180_000);
  });
});
