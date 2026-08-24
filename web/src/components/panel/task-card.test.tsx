import ReactDOMServer from "react-dom/server";
import { Provider } from "jotai";
import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "@hermes/protocol";
import { chatRuntimeBySessionAtom, createEmptyChatRuntime, type ChatRuntimeBySession } from "@/stores/chat";
import { __resetUiStoreForTests } from "@/lib/ui-store";
import { rememberSessionMapping } from "@/lib/session-map";
import { TaskCard } from "./task-card";

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "persist-1",
    source: "tui",
    user_id: null,
    model: "deepseek-v4-flash",
    title: "审查 PR",
    preview: "正在对比基线分支差异…",
    started_at: 1_700_000_000,
    ended_at: null,
    message_count: 3,
    input_tokens: 100,
    output_tokens: 50,
    estimated_cost_usd: null,
    is_active: true,
    ...overrides,
  } as SessionSummary;
}

function renderTaskCard(sessionId: string, runtimeBySession: ChatRuntimeBySession) {
  const store = createStore();
  store.set(chatRuntimeBySessionAtom, runtimeBySession);
  return ReactDOMServer.renderToStaticMarkup(
    <Provider store={store}>
      <TaskCard session={session({ id: sessionId })} onClick={() => {}} />
    </Provider>,
  );
}

describe("TaskCard", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
  });

  it("shows the pending approval count when the runtime is keyed by the gateway session id", () => {
    // gateway id 与 persistent id 的映射（mergeLiveRuntimeSessions 会把合成
    // 会话的 id 设成 persistent id，而 runtime 桶仍以 gateway id 为 key）。
    rememberSessionMapping("gw-1", "persist-1");
    const runtime = {
      ...createEmptyChatRuntime(1_700_000_000_000),
      streamStatus: "streaming" as const,
      pendingApprovals: [
        { requestId: "r1", sessionId: "persist-1", command: "apply_patch" },
      ],
    };

    const html = renderTaskCard("persist-1", { "gw-1": runtime });

    expect(html).toContain("1 待审批");
  });

  it("still renders fine when no runtime is present", () => {
    const html = renderTaskCard("persist-unknown", {});
    expect(html).toContain("运行中");
    expect(html).not.toContain("待审批");
  });
});
