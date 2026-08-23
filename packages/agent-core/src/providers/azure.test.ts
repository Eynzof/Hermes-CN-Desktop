import { describe, expect, it } from "vitest";
import { AzureAdapter, createAzureAdapter, type AzureCredentialProvider } from "./azure.js";
import { ProviderError, isRecoverableError } from "../errors.js";
import type { LLMChatParams } from "../types.js";

function minimalParams(): LLMChatParams {
  return { messages: [], tools: [], signal: new AbortController().signal };
}

function internals(adapter: AzureAdapter): {
  endpoint?: string;
  apiVersion?: string;
  credentials?: AzureCredentialProvider;
  apiKey?: string;
} {
  return adapter as unknown as {
    endpoint?: string;
    apiVersion?: string;
    credentials?: AzureCredentialProvider;
    apiKey?: string;
  };
}

const fakeCredentials: AzureCredentialProvider = {
  tenantId: "tenant-1",
  clientId: "client-1",
  clientSecret: "secret-1",
  getToken: async () => ({ token: "tok", expiresOnTimestamp: Date.now() + 1000 }),
};

describe("AzureAdapter constructor", () => {
  it("exposes modelName and systemPrompt", () => {
    const adapter = new AzureAdapter({ model: "gpt-4o", systemPrompt: "Be concise." });
    expect(adapter.modelName).toBe("gpt-4o");
    expect(adapter.systemPrompt).toBe("Be concise.");
  });

  it("stores endpoint, apiVersion, credentials and apiKey", () => {
    const adapter = new AzureAdapter({
      model: "gpt-4o",
      endpoint: "https://my-resource.openai.azure.com",
      apiVersion: "2024-06-01",
      credentials: fakeCredentials,
      apiKey: "az-key",
    });
    const opts = internals(adapter);
    expect(opts.endpoint).toBe("https://my-resource.openai.azure.com");
    expect(opts.apiVersion).toBe("2024-06-01");
    expect(opts.credentials).toBe(fakeCredentials);
    expect(opts.apiKey).toBe("az-key");
  });

  it("does not require endpoint/credentials (token can come later)", () => {
    const opts = internals(new AzureAdapter({ model: "gpt-4o" }));
    expect(opts.endpoint).toBeUndefined();
    expect(opts.apiVersion).toBeUndefined();
    expect(opts.credentials).toBeUndefined();
    expect(opts.apiKey).toBeUndefined();
  });

  it("keeps a credentials object without getToken", () => {
    const creds: AzureCredentialProvider = { tenantId: "t", clientId: "c" };
    const adapter = new AzureAdapter({ model: "gpt-4o", credentials: creds });
    expect(internals(adapter).credentials).toBe(creds);
  });
});

describe("AzureAdapter.chat", () => {
  it("rejects with ProviderError naming the azure provider", async () => {
    const adapter = new AzureAdapter({ model: "gpt-4o" });
    await expect(adapter.chat(minimalParams())).rejects.toSatisfy((error: unknown) => {
      return error instanceof ProviderError && error.provider === "azure";
    });
  });

  it("rejects with the model in the message and code provider_error", async () => {
    const adapter = new AzureAdapter({ model: "gpt-4o-mini" });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      const providerError = error as ProviderError;
      expect(providerError.code).toBe("provider_error");
      expect(providerError.message).toContain("gpt-4o-mini");
      expect(providerError.message).toContain("not implemented");
    }
  });

  it("is treated as recoverable when no status code is set (transient semantics)", async () => {
    const adapter = new AzureAdapter({ model: "gpt-4o" });
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

describe("createAzureAdapter", () => {
  it("creates an adapter from model and credentials", () => {
    const adapter = createAzureAdapter("gpt-4o", fakeCredentials);
    expect(adapter).toBeInstanceOf(AzureAdapter);
    expect(adapter.modelName).toBe("gpt-4o");
    expect(internals(adapter).credentials).toBe(fakeCredentials);
  });

  it("works without credentials", () => {
    const adapter = createAzureAdapter("gpt-4o");
    expect(internals(adapter).credentials).toBeUndefined();
  });
});
