import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentError,
  AgentRuntime,
  clearProviders,
  registerProvider,
} from "../index.js";
import type {
  AgentEvent,
  AgentStatusEvent,
  LLM,
  LLMChatParams,
  LLMChatResponse,
  ProfileSnapshot,
} from "../index.js";

function makeProfile(model = "echo", provider = "test"): ProfileSnapshot {
  return {
    model,
    provider,
    apiMode: "chat_completions",
  };
}

class EchoLLM implements LLM {
  readonly modelName = "echo";
  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
    const text = lastUser ? `Echo: ${lastUser.content}` : "Echo";
    return { text, toolCalls: [], usage: { input: 1, output: 1, total: 2 } };
  }
}

class LongEchoLLM implements LLM {
  readonly modelName = "long-echo";
  constructor(private readonly length: number) {}
  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
    const text = `Echo: ${lastUser?.content ?? ""}`.padEnd(this.length, "x");
    return { text, toolCalls: [], usage: { input: 1, output: 1, total: 2 } };
  }
}

/** LLM whose chat promise only resolves when the test releases it. */
class DeferredLLM implements LLM {
  readonly modelName = "deferred";
  private resolveChat: ((response: LLMChatResponse) => void) | undefined;

  chat(_params: LLMChatParams): Promise<LLMChatResponse> {
    return new Promise((resolve) => {
      this.resolveChat = resolve;
    });
  }

  release(): void {
    this.resolveChat?.({
      text: "late reply",
      toolCalls: [],
      usage: { input: 0, output: 0, total: 0 },
    });
  }
}

describe("AgentRuntime (supplemental)", () => {
  beforeEach(() => {
    clearProviders();
  });

  it("createSession emits session.info with model and provider", async () => {
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime();
    runtime.on((event) => events.push(event));

    const session = await runtime.createSession(makeProfile("m", "p"));

    const info = events.find((e) => e.type === "session.info");
    expect(info).toBeDefined();
    if (info?.type === "session.info") {
      expect(info.session_id).toBe(session.id);
      expect(info.payload).toMatchObject({ model: "m", provider: "p" });
    }
  });

  it("resumeSession returns undefined for a missing session", async () => {
    const runtime = new AgentRuntime();
    await expect(runtime.resumeSession("missing")).resolves.toBeUndefined();
  });

  it("resumeSession emits session.info for an existing session", async () => {
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime();
    runtime.on((event) => events.push(event));
    const session = await runtime.createSession(makeProfile("m", "p"));

    const resumed = await runtime.resumeSession(session.id);

    expect(resumed?.id).toBe(session.id);
    expect(events.filter((e) => e.type === "session.info")).toHaveLength(2);
  });

  it("submitPrompt throws provider_not_available when the llm factory returns undefined", async () => {
    const runtime = new AgentRuntime({
      llmFactory: () => undefined,
    });
    const session = await runtime.createSession(makeProfile("m", "no-provider"));

    const error = await runtime.submitPrompt(session.id, "hi").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("provider_not_available");
    expect((error as AgentError).message).toContain("no-provider");
  });

  it("submitPrompt uses the default factory and reports an unavailable chat_completions provider", async () => {
    registerProvider({
      slug: "chat",
      name: "Chat Provider",
      apiMode: "chat_completions",
      authKind: "api_key",
      model: "m",
    });
    const runtime = new AgentRuntime();
    const session = await runtime.createSession(makeProfile("m", "chat"));

    const error = await runtime.submitPrompt(session.id, "hi").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("provider_not_available");
  });

  it("submitPrompt appends user and assistant messages and updates session counters", async () => {
    const runtime = new AgentRuntime({
      llmFactory: () => new EchoLLM(),
    });
    const session = await runtime.createSession(makeProfile());

    const result = await runtime.submitPrompt(session.id, "hello");

    expect(result.text).toBe("Echo: hello");
    expect(result.stopReason).toBe("stop");
    expect(typeof result.turnId).toBe("string");

    const stored = await runtime.getStore().getMessages(session.id);
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);

    const updated = await runtime.getStore().getSession(session.id);
    expect(updated?.messageCount).toBe(1);
    expect(updated?.inputTokens).toBe(1);
    expect(updated?.outputTokens).toBe(1);
    expect(updated?.preview).toBe("Echo: hello");
  });

  it("submitPrompt truncates the session preview to 200 characters", async () => {
    const runtime = new AgentRuntime({
      llmFactory: () => new LongEchoLLM(500),
    });
    const session = await runtime.createSession(makeProfile());

    await runtime.submitPrompt(session.id, "hello");

    const updated = await runtime.getStore().getSession(session.id);
    expect(updated?.preview).toHaveLength(200);
    expect(updated?.preview).toBe("Echo: hello".padEnd(200, "x"));
  });

  it("switchModel returns undefined for a missing session", async () => {
    const runtime = new AgentRuntime();
    await expect(runtime.switchModel("missing", "m")).resolves.toBeUndefined();
  });

  it("switchModel updates only the model when no provider is given", async () => {
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime();
    runtime.on((event) => events.push(event));
    const session = await runtime.createSession(makeProfile("old", "keep-provider"));

    const updated = await runtime.switchModel(session.id, "new-model");

    expect(updated?.profile.model).toBe("new-model");
    expect(updated?.profile.provider).toBe("keep-provider");
    const infos = events.filter((e) => e.type === "session.info");
    expect(infos).toHaveLength(2); // createSession + switchModel
    const last = infos[infos.length - 1];
    if (last?.type === "session.info") {
      expect(last.session_id).toBe(session.id);
      expect(last.payload).toMatchObject({ model: "new-model", provider: "keep-provider" });
    }
  });

  it("switchModel copies apiMode from the registered provider profile", async () => {
    registerProvider({
      slug: "codex",
      name: "Codex Provider",
      apiMode: "codex_responses",
      authKind: "api_key",
      model: "codex-model",
    });
    const runtime = new AgentRuntime();
    const session = await runtime.createSession(makeProfile("old", "old-provider"));

    const updated = await runtime.switchModel(session.id, "codex-model", "codex");

    expect(updated?.profile.model).toBe("codex-model");
    expect(updated?.profile.provider).toBe("codex");
    expect(updated?.profile.apiMode).toBe("codex_responses");
  });

  it("interrupt returns false and emits nothing when no turn is active", async () => {
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime();
    runtime.on((event) => events.push(event));

    expect(await runtime.interrupt("missing-session")).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("interrupt returns false after a turn has completed", async () => {
    const runtime = new AgentRuntime({ llmFactory: () => new EchoLLM() });
    const session = await runtime.createSession(makeProfile());
    await runtime.submitPrompt(session.id, "hello");

    expect(await runtime.interrupt(session.id)).toBe(false);
  });

  it("interrupt aborts an in-flight turn and emits agent.status", async () => {
    const events: AgentEvent[] = [];
    const llm = new DeferredLLM();
    const runtime = new AgentRuntime({ llmFactory: () => llm });
    runtime.on((event) => events.push(event));
    const session = await runtime.createSession(makeProfile());

    const pending = runtime.submitPrompt(session.id, "hello");
    // Let the async chain reach the (pending) LLM call.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await runtime.interrupt(session.id)).toBe(true);

    const status = events.find((e): e is AgentStatusEvent => e.type === "agent.status");
    expect(status).toBeDefined();
    if (status) {
      expect(status.session_id).toBe(session.id);
      expect(status.payload.kind).toBe("interrupted");
    }

    llm.release();
    const result = await pending;
    expect(result.stopReason).toBe("aborted");

    // The turn is no longer tracked after it settles.
    expect(await runtime.interrupt(session.id)).toBe(false);
  });

  it("on() unsubscribe stops receiving events", async () => {
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime();
    const unsubscribe = runtime.on((event) => events.push(event));

    const session = await runtime.createSession(makeProfile());
    expect(events.some((e) => e.type === "session.info")).toBe(true);

    unsubscribe();
    await runtime.resumeSession(session.id);
    expect(events.filter((e) => e.type === "session.info")).toHaveLength(1);
  });

  it("listModels includes model, fallbackModels and capabilities, and skips providers without models", async () => {
    registerProvider({
      slug: "p1",
      name: "P1",
      apiMode: "chat_completions",
      authKind: "api_key",
      model: "m1",
      fallbackModels: ["f1"],
      capabilities: { streaming: true },
    });
    registerProvider({
      slug: "p2",
      name: "P2",
      apiMode: "codex_responses",
      authKind: "none",
    });

    const runtime = new AgentRuntime();
    const models = await runtime.listModels();

    expect(models).toEqual([
      { provider: "p1", model: "m1", capabilities: { streaming: true } },
      { provider: "p1", model: "f1", capabilities: { streaming: true } },
    ]);
  });
});
