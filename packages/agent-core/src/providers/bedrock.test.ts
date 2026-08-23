import { describe, expect, it } from "vitest";
import { BedrockAdapter, createBedrockAdapter, type BedrockCredentialProvider } from "./bedrock.js";
import { ProviderError, isRecoverableError } from "../errors.js";
import type { LLMChatParams } from "../types.js";

function minimalParams(): LLMChatParams {
  return { messages: [], tools: [], signal: new AbortController().signal };
}

function internals(adapter: BedrockAdapter): {
  region?: string;
  credentials?: BedrockCredentialProvider;
} {
  return adapter as unknown as {
    region?: string;
    credentials?: BedrockCredentialProvider;
  };
}

const fakeCredentials: BedrockCredentialProvider = {
  region: "us-east-1",
  accessKeyId: "AKIA-test",
  secretAccessKey: "secret",
  sessionToken: "session",
  getCredentials: async () => ({
    accessKeyId: "AKIA-test",
    secretAccessKey: "secret",
    sessionToken: "session",
  }),
};

describe("BedrockAdapter constructor", () => {
  it("exposes modelName and systemPrompt", () => {
    const adapter = new BedrockAdapter({
      model: "anthropic.claude-3-sonnet",
      systemPrompt: "Act as a senior engineer.",
    });
    expect(adapter.modelName).toBe("anthropic.claude-3-sonnet");
    expect(adapter.systemPrompt).toBe("Act as a senior engineer.");
  });

  it("stores region and credentials", () => {
    const adapter = new BedrockAdapter({
      model: "anthropic.claude-3-sonnet",
      region: "eu-west-1",
      credentials: fakeCredentials,
    });
    const opts = internals(adapter);
    expect(opts.region).toBe("eu-west-1");
    expect(opts.credentials).toBe(fakeCredentials);
  });

  it("leaves region/credentials undefined when omitted", () => {
    const opts = internals(new BedrockAdapter({ model: "anthropic.claude-3-sonnet" }));
    expect(opts.region).toBeUndefined();
    expect(opts.credentials).toBeUndefined();
  });
});

describe("BedrockAdapter.chat", () => {
  it("rejects with ProviderError naming the bedrock provider", async () => {
    const adapter = new BedrockAdapter({ model: "anthropic.claude-3-sonnet" });
    await expect(adapter.chat(minimalParams())).rejects.toSatisfy((error: unknown) => {
      return error instanceof ProviderError && error.provider === "bedrock";
    });
  });

  it("rejects with the model in the message and code provider_error", async () => {
    const adapter = new BedrockAdapter({ model: "anthropic.claude-3-haiku" });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      const providerError = error as ProviderError;
      expect(providerError.code).toBe("provider_error");
      expect(providerError.message).toContain("anthropic.claude-3-haiku");
      expect(providerError.message).toContain("not implemented");
    }
  });

  it("is treated as recoverable when no status code is set (transient semantics)", async () => {
    const adapter = new BedrockAdapter({ model: "anthropic.claude-3-sonnet" });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      // ProviderError: recoverable = statusCode === undefined || >= 500 || 429
      expect((error as ProviderError).statusCode).toBeUndefined();
      expect((error as ProviderError).recoverable).toBe(true);
      expect(isRecoverableError(error)).toBe(true);
    }
  });
});

describe("createBedrockAdapter", () => {
  it("creates an adapter from model and credentials", () => {
    const adapter = createBedrockAdapter("anthropic.claude-3-sonnet", fakeCredentials);
    expect(adapter).toBeInstanceOf(BedrockAdapter);
    expect(adapter.modelName).toBe("anthropic.claude-3-sonnet");
    expect(internals(adapter).credentials).toBe(fakeCredentials);
  });

  it("works without credentials", () => {
    const adapter = createBedrockAdapter("anthropic.claude-3-sonnet");
    expect(internals(adapter).credentials).toBeUndefined();
  });
});
