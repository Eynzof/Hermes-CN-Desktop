/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetUiStoreForTests } from "./ui-store";
import {
  getLocalSessionStore,
  resetLocalSessionStore,
} from "./session-store/local-store";
import {
  streamLocalTurn,
  type LocalTurnEvent,
} from "./local-agent";

/**
 * Bug repro: 工作台 → 最近会话 → 打开会话后，第一轮正常，第二轮报
 * "model returned empty reply"。
 *
 * Root cause: `callRemoteModel` sends ONLY the current user message with no
 * conversation history. A follow-up ("next talk") therefore reaches the real
 * LLM as a stateless single message; real reasoning-capable models can answer
 * that with `content: null` (reasoning-only), and local-agent then throws
 * "model returned empty reply" instead of continuing the conversation.
 *
 * The fake LLM below mirrors that: a single-message request for the second
 * question returns empty content (like a reasoning model that has no context
 * to continue from), while a request carrying the previous exchange returns a
 * normal reply.
 */

const STORE_KEY = "hermes.local-sql.local-sessions-v1";
const SESSION_ID = "20260824_000000_localagent";

function jsonResponse(message: { content: string | null; reasoning_content?: string }) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "fake-model",
        choices: [{ index: 0, message, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
    async text() {
      return "";
    },
  } as Response;
}

interface CapturedRequest {
  url: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
}

function seedRealConfig(): void {
  __resetUiStoreForTests({
    "hermes.active-config": {
      model: {
        provider: "ep-to-activate",
        default: "fake-model",
        base_url: "http://127.0.0.1:9999/v1",
        api_key: "sk-test-key",
        api_mode: "chat_completions",
      },
      model_context_length: 64000,
    },
    "hermes.env-vars": {
      OPENAI_API_KEY: "sk-test-key",
    },
  });
}

async function runTurn(text: string): Promise<LocalTurnEvent[]> {
  const events: LocalTurnEvent[] = [];
  await streamLocalTurn({
    sessionId: SESSION_ID,
    text,
    emit: (ev) => events.push(ev),
    now: 1_700_000_000_000,
  });
  return events;
}

function completeText(events: LocalTurnEvent[]): string | null {
  const complete = events.find((ev) => ev.type === "message.complete");
  const payload = complete?.payload as { text?: string } | undefined;
  return payload?.text ?? null;
}

function errorMessage(events: LocalTurnEvent[]): string | null {
  const err = events.find((ev) => ev.type === "error");
  const payload = err?.payload as { message?: string } | undefined;
  return payload?.message ?? null;
}

describe("local-agent follow-up turns (工作台最近会话 → 第二轮)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let captured: CapturedRequest[];

  beforeEach(() => {
    captured = [];
    fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
        stream: boolean;
        max_tokens: number;
      };
      captured.push({ url: String(_input), messages: body.messages, max_tokens: body.max_tokens });

      const userTexts = body.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content);

      // Simulate a real reasoning model: a *stateless* second question gets no
      // context and returns reasoning-only (content: null) → the bug.
      if (userTexts.length === 1 && userTexts[0] === "第二个问题") {
        return jsonResponse({ content: null, reasoning_content: "（思考：缺少上下文，无法继续）" });
      }

      const lastUser = userTexts[userTexts.length - 1] ?? "";
      return jsonResponse({ content: `收到：${lastUser}` });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Fresh UI store + fresh local session store for every test.
    seedRealConfig();
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      // jsdom without storage — ignore
    }
    resetLocalSessionStore();
  });

  it("first and second turns both succeed with a real LLM config (regression)", async () => {
    const store = getLocalSessionStore();
    await store.create({ now: 1_700_000_000_000 });

    const first = await runTurn("第一个问题");
    expect(completeText(first)).toBe("收到：第一个问题");
    expect(errorMessage(first)).toBeNull();
    // Unknown model + seeded model_context_length 64000 → 64000 // 4.
    expect(captured[0].max_tokens).toBe(16_000);

    const second = await runTurn("第二个问题");
    // Regression: the second talk used to fail with "model returned empty
    // reply" because the request carried no conversation history.
    expect(errorMessage(second)).toBeNull();
    expect(completeText(second)).toBe("收到：第二个问题");
    expect(captured[1].max_tokens).toBe(16_000);
  });

  it("second turn sends the previous exchange as conversation history", async () => {
    const store = getLocalSessionStore();
    await store.create({ now: 1_700_000_000_000 });

    await runTurn("第一个问题");
    const second = await runTurn("第二个问题");

    // The request for the follow-up must carry the full conversation, not a
    // stateless single message.
    const secondRequest = captured[captured.length - 1];
    expect(secondRequest.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(secondRequest.messages.map((m) => m.content)).toEqual([
      "第一个问题",
      "收到：第一个问题",
      "第二个问题",
    ]);
    expect(completeText(second)).toBe("收到：第二个问题");
    expect(errorMessage(second)).toBeNull();
  });

  it("falls back to reasoning_content when the model returns content: null", async () => {
    const store = getLocalSessionStore();
    await store.create({ now: 1_700_000_000_000 });
    // Override the fetch mock for this test: the model answers a stateless
    // request with reasoning-only output, which must not surface as an error.
    fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages: Array<{ role: string; content: string }>;
      };
      const userTexts = body.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content);
      if (userTexts.length === 1 && userTexts[0] === "第二个问题") {
        return jsonResponse({ content: null, reasoning_content: "（推理：先分析再回答）" });
      }
      return jsonResponse({ content: `收到：${userTexts[userTexts.length - 1] ?? ""}` });
    });

    const second = await runTurn("第二个问题");
    expect(errorMessage(second)).toBeNull();
    expect(completeText(second)).toBe("（推理：先分析再回答）");
  });
});
