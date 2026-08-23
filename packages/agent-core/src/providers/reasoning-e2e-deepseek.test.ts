/**
 * Real end-to-end reasoning tests against the live DeepSeek API.
 *
 * These tests verify that the OpenAI chat-completions and Responses (codex)
 * adapters correctly enable reasoning effort and accept/return thinking
 * blocks, and that the Anthropic adapter builds the correct ``thinking``
 * parameter — all against the live DeepSeek API (``https://api.deepseek.com``),
 * which exposes both an OpenAI-compatible ``/v1/chat/completions`` surface
 * (with ``reasoning_content``) and an OpenAI-compatible ``/v1/responses``
 * surface (with ``reasoning`` output items).
 *
 * The DeepSeek API key is read from the ``DEEPSEEK_API_KEY`` environment
 * variable and is NEVER hardcoded in this file (it is a secret). Tests are
 * skipped automatically when the env var is absent so CI stays closed.
 *
 * Run locally with::
 *
 *     DEEPSEEK_API_KEY=sk-... pnpm --filter @hermes/agent-core test:unit -- \
 *         src/providers/reasoning-e2e-deepseek.test.ts -t 'reasoning'
 */

import { describe, it, expect } from "vitest";
import { OpenAIChatAdapter } from "./openai-chat.js";
import { OpenAIResponsesAdapter } from "./openai-responses.js";
import { AnthropicAdapter } from "./anthropic.js";
import type { LLMChatParams, Message } from "../types.js";

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY ?? "").trim();
// The adapters append "/v1/chat/completions" and "/v1/responses" to the
// baseUrl, so the base must be the host root (no trailing /v1).
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const REASONING_MODEL = "deepseek-v4-flash"; // V4 family has thinking ON by default

// Skip the whole module when the secret isn't present — CI stays closed and
// we never hardcode the key.
const describeLive = DEEPSEEK_API_KEY ? describe : describe.skip;

function baseMessages(prompt: string): Message[] {
  return [{ role: "user", content: prompt }];
}

function paramsFor(prompt: string, opts: Partial<LLMChatParams> = {}): LLMChatParams {
  return {
    messages: baseMessages(prompt),
    tools: [],
    signal: new AbortController().signal,
    ...opts,
  };
}

// ── Chat Completions adapter ───────────────────────────────────────────────

describeLive("OpenAIChatAdapter — live DeepSeek reasoning E2E", () => {
  it("non-stream returns BOTH a thinking block (reasoning_content) and a text block", async () => {
    const adapter = new OpenAIChatAdapter({
      model: REASONING_MODEL,
      apiKey: DEEPSEEK_API_KEY,
      baseUrl: DEEPSEEK_BASE_URL,
      reasoningConfig: { enabled: true, effort: "medium" },
    });

    const thinkDeltas: string[] = [];
    const textDeltas: string[] = [];
    const res = await adapter.chat(
      paramsFor("What is 17 * 23? Think briefly, then give the answer.", {
        onThinkDelta: (d) => thinkDeltas.push(d),
        onTextDelta: (d) => textDeltas.push(d),
      }),
    );

    // ── Thinking block present ───────────────────────────────────────
    expect(typeof res.reasoning).toBe("string");
    expect((res.reasoning ?? "").length).toBeGreaterThan(0);
    // onThinkDelta fired for the reasoning content
    expect(thinkDeltas.join("").length).toBeGreaterThan(0);

    // ── Text block present ───────────────────────────────────────────
    expect(typeof res.text).toBe("string");
    expect((res.text ?? "").length).toBeGreaterThan(0);
    expect(res.text).toContain("391");

    // onTextDelta fired for the visible text
    expect(textDeltas.join("").length).toBeGreaterThan(0);

    // Reasoning tokens accounted for in usage
    expect(res.usage.reasoning ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it("stream yields reasoning_content deltas followed by content deltas", async () => {
    const adapter = new OpenAIChatAdapter({
      model: REASONING_MODEL,
      apiKey: DEEPSEEK_API_KEY,
      baseUrl: DEEPSEEK_BASE_URL,
      reasoningConfig: { enabled: true, effort: "low" },
    });

    const thinkDeltas: string[] = [];
    const textDeltas: string[] = [];
    const res = await adapter.chat(
      paramsFor("What is 8 + 5? Think, then answer.", {
        stream: true,
        onThinkDelta: (d) => thinkDeltas.push(d),
        onTextDelta: (d) => textDeltas.push(d),
      }),
    );

    const reasoningText = thinkDeltas.join("").trim();
    const contentText = textDeltas.join("").trim();

    // Both the thinking block and the text block must be non-empty.
    expect(reasoningText.length).toBeGreaterThan(0);
    expect(contentText.length).toBeGreaterThan(0);
    expect(contentText).toContain("13");

    // Aggregated response mirrors the streamed deltas.
    expect((res.reasoning ?? "").trim()).toBe(reasoningText);
    expect(res.text.trim()).toBe(contentText);
  }, 60_000);

  it("auto-enable reasoning from history does not 400 (kosong #1616 parity)", async () => {
    // History that carries reasoning_content from a prior thinking turn, with
    // NO explicit reasoning_config. The adapter still sends
    // reasoning_effort=medium + thinking enabled for the V4 model so the strict
    // gateway does not 400 on the reasoning_content in history.
    const adapter = new OpenAIChatAdapter({
      model: REASONING_MODEL,
      apiKey: DEEPSEEK_API_KEY,
      baseUrl: DEEPSEEK_BASE_URL,
      // No reasoningConfig — the adapter defaults to medium for V4 thinking.
    });

    const messages: Message[] = [
      { role: "user", content: "What is 2 + 2? Think, then answer." },
      {
        role: "assistant",
        content: "4",
        reasoningContent: "2 plus 2 equals 4.",
      },
      { role: "user", content: "Now what is 3 + 3?" },
    ];

    const res = await adapter.chat({
      messages,
      tools: [],
      signal: new AbortController().signal,
    });

    // No 400 — the call succeeded.
    expect(res.text.trim()).toContain("6");
    // The follow-up thinking turn still carries a reasoning block.
    expect((res.reasoning ?? "").length).toBeGreaterThan(0);
  }, 60_000);
});

// ── Responses (codex) adapter ───────────────────────────────────────────────

describeLive("OpenAIResponsesAdapter — live DeepSeek reasoning E2E", () => {
  it("returns a reasoning output item (thinking) and a message output item (text)", async () => {
    const adapter = new OpenAIResponsesAdapter({
      model: REASONING_MODEL,
      apiKey: DEEPSEEK_API_KEY,
      baseUrl: DEEPSEEK_BASE_URL,
      reasoningConfig: { enabled: true, effort: "medium" },
    });

    const messages: Message[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is 9 * 9? Think, then answer." },
    ];

    const thinkDeltas: string[] = [];
    const textDeltas: string[] = [];
    const res = await adapter.chat({
      messages,
      tools: [],
      signal: new AbortController().signal,
      onThinkDelta: (d) => thinkDeltas.push(d),
      onTextDelta: (d) => textDeltas.push(d),
    });

    // ── Reasoning (thinking) block present ───────────────────────────
    expect((res.reasoning ?? "").length).toBeGreaterThan(0);
    expect(thinkDeltas.join("").length).toBeGreaterThan(0);

    // ── Text block present ───────────────────────────────────────────
    expect((res.text ?? "").length).toBeGreaterThan(0);
    expect(res.text).toContain("81");
    expect(textDeltas.join("").length).toBeGreaterThan(0);

    // Reasoning tokens accounted for
    expect(res.usage.reasoning ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it("succeeds without the reasoning kwarg when reasoning is disabled", async () => {
    const adapter = new OpenAIResponsesAdapter({
      model: REASONING_MODEL,
      apiKey: DEEPSEEK_API_KEY,
      baseUrl: DEEPSEEK_BASE_URL,
      reasoningConfig: { enabled: false },
    });

    const res = await adapter.chat(
      paramsFor("Say hi."),
    );

    // The live call must still succeed (no HTTP 400) without the kwarg.
    // Note: DeepSeek V4 thinks by default server-side, so reasoning may still
    // be present — the contract under test is that the call succeeds and
    // returns text.
    expect((res.text ?? "").length).toBeGreaterThan(0);
  }, 60_000);
});

// ── Anthropic adapter (kwargs correctness — DeepSeek has no /v1/messages) ───

describe("AnthropicAdapter — thinking kwargs correctness", () => {
  it("emits adaptive thinking for Claude 4.6+ when reasoning is enabled", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "Plan", signature: "sig" },
            { type: "text", text: "42" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const adapter = new AnthropicAdapter({
      model: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: true, effort: "high" },
    });
    const res = await adapter.chat({
      messages: [{ role: "user", content: "Think and answer: 7*6?" }],
      tools: [],
      signal: new AbortController().signal,
    });
    expect(capturedBody.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(capturedBody.output_config).toEqual({ effort: "high" });
    expect(res.reasoning).toBe("Plan");
    expect(res.text).toBe("42");
  });

  it("emits manual thinking for legacy Claude when reasoning is enabled", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "Step", signature: "sig" },
            { type: "text", text: "ok" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const adapter = new AnthropicAdapter({
      model: "claude-3-7-sonnet-20250219",
      apiKey: "sk-ant-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: true, effort: "high" },
    });
    const res = await adapter.chat({
      messages: [{ role: "user", content: "Think and answer: 7*6?" }],
      tools: [],
      signal: new AbortController().signal,
    });
    expect(capturedBody.thinking).toEqual({
      type: "enabled",
      budget_tokens: expect.any(Number),
    });
    expect(capturedBody.temperature).toBe(1);
    expect(res.reasoning).toBe("Step");
    expect(res.text).toBe("ok");
  });

  it("omits the thinking parameter when reasoning is disabled", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const adapter = new AnthropicAdapter({
      model: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reasoningConfig: { enabled: false },
    });
    await adapter.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: new AbortController().signal,
    });
    expect("thinking" in capturedBody).toBe(false);
    expect("output_config" in capturedBody).toBe(false);
  });

  it("omits the thinking parameter when no reasoning config is set", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const adapter = new AnthropicAdapter({
      model: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await adapter.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: new AbortController().signal,
    });
    expect("thinking" in capturedBody).toBe(false);
    expect("output_config" in capturedBody).toBe(false);
  });
});
