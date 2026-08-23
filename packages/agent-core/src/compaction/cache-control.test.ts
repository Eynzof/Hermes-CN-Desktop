import { describe, expect, it } from "vitest";
import {
  attachMessageCacheControl,
  attachToolCacheControl,
  buildOpenAiCacheMetadata,
  createCacheControl,
  isAnthropicProvider,
  stripCacheControl,
} from "./cache-control.js";
import type { CompactionMessage } from "./types.js";
import type { Message, Tool } from "../types.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return { role: "user", content: "hello", ...overrides };
}

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "get_weather",
    description: "Get the weather",
    parameters: { type: "object" },
    async execute() {
      return { content: "ok" };
    },
    ...overrides,
  };
}

describe("isAnthropicProvider", () => {
  it("returns true for anthropic and openrouter", () => {
    expect(isAnthropicProvider("anthropic")).toBe(true);
    expect(isAnthropicProvider("openrouter")).toBe(true);
  });

  it("returns false for openai and generic", () => {
    expect(isAnthropicProvider("openai")).toBe(false);
    expect(isAnthropicProvider("generic")).toBe(false);
  });
});

describe("createCacheControl", () => {
  it("creates an ephemeral marker for anthropic and openrouter", () => {
    expect(createCacheControl("anthropic")).toEqual({ type: "ephemeral" });
    expect(createCacheControl("openrouter")).toEqual({ type: "ephemeral" });
  });

  it("creates an OpenAI metadata hint for openai", () => {
    expect(createCacheControl("openai")).toEqual({
      provider: "openai",
      metadata: { use_cached_tokens: true },
    });
  });

  it("returns undefined for providers without block-level markers", () => {
    expect(createCacheControl("generic")).toBeUndefined();
  });
});

describe("attachMessageCacheControl", () => {
  it("returns a new message with cache_control for anthropic and leaves the original untouched", () => {
    const message = makeMessage();
    const decorated = attachMessageCacheControl(message as CompactionMessage, "anthropic");

    expect(decorated).not.toBe(message);
    expect(decorated.cache_control).toEqual({ type: "ephemeral" });
    expect(decorated.role).toBe("user");
    expect(decorated.content).toBe("hello");
    expect((message as CompactionMessage).cache_control).toBeUndefined();
  });

  it("decorates for openrouter as well", () => {
    const message = makeMessage();
    const decorated = attachMessageCacheControl(message as CompactionMessage, "openrouter");
    expect(decorated.cache_control).toEqual({ type: "ephemeral" });
  });

  it("handles string content and preserves other fields", () => {
    const message = makeMessage({ role: "system", content: "sys", id: "m1", timestamp: 123 });
    const decorated = attachMessageCacheControl(message as CompactionMessage, "anthropic");
    expect(decorated).toMatchObject({ role: "system", content: "sys", id: "m1", timestamp: 123 });
    expect(decorated.cache_control).toEqual({ type: "ephemeral" });
  });

  it("returns the same reference for non-Anthropic providers", () => {
    const message = makeMessage();
    expect(attachMessageCacheControl(message as CompactionMessage, "openai")).toBe(message);
    expect(attachMessageCacheControl(message as CompactionMessage, "generic")).toBe(message);
  });
});

describe("attachToolCacheControl", () => {
  it("returns a new tool with cache_control for anthropic and leaves the original untouched", () => {
    const tool = makeTool();
    const decorated = attachToolCacheControl(tool, "anthropic");

    expect(decorated).not.toBe(tool);
    expect(decorated).toMatchObject({ name: "get_weather", description: "Get the weather" });
    expect(decorated).toHaveProperty("cache_control", { type: "ephemeral" });
    expect(tool).not.toHaveProperty("cache_control");
  });

  it("decorates for openrouter as well", () => {
    const tool = makeTool();
    expect(attachToolCacheControl(tool, "openrouter")).toHaveProperty("cache_control", {
      type: "ephemeral",
    });
  });

  it("returns the same reference for non-Anthropic providers", () => {
    const tool = makeTool();
    expect(attachToolCacheControl(tool, "openai")).toBe(tool);
    expect(attachToolCacheControl(tool, "generic")).toBe(tool);
  });
});

describe("stripCacheControl", () => {
  it("removes cache_control from messages that have it and preserves the rest", () => {
    const plain = makeMessage({ role: "system", content: "sys" });
    const decorated = { ...makeMessage({ role: "user", content: "u1" }), cache_control: { type: "ephemeral" as const } };
    const result = stripCacheControl([plain, decorated]);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toBe(plain);
    expect(result.messages[1]).not.toBe(decorated);
    expect(result.messages[1]).toEqual({ role: "user", content: "u1" });
    expect(result.messages[1]).not.toHaveProperty("cache_control");
  });

  it("removes cache_control from tools that have it and preserves the rest", () => {
    const plain = makeTool();
    const decorated = { ...makeTool({ name: "cached_tool" }), cache_control: { type: "ephemeral" } };
    const result = stripCacheControl([], [plain, decorated]);

    expect(result.tools).toHaveLength(2);
    expect(result.tools![0]).toBe(plain);
    expect(result.tools![1]).not.toBe(decorated);
    expect(result.tools![1]).toMatchObject({ name: "cached_tool" });
    expect(result.tools![1]).not.toHaveProperty("cache_control");
  });

  it("returns an empty tools array when tools is empty", () => {
    const result = stripCacheControl([makeMessage()], []);
    expect(result.tools).toEqual([]);
  });

  it("leaves tools undefined when not provided", () => {
    const result = stripCacheControl([makeMessage()]);
    expect(result.tools).toBeUndefined();
  });

  it("works with a falsy cache_control value (leaves the message untouched)", () => {
    const withFalsy = { ...makeMessage(), cache_control: undefined };
    const result = stripCacheControl([withFalsy]);
    expect(result.messages[0]).toBe(withFalsy);
  });
});

describe("buildOpenAiCacheMetadata", () => {
  it("returns the use_cached_tokens hint", () => {
    expect(buildOpenAiCacheMetadata()).toEqual({ use_cached_tokens: true });
  });
});
