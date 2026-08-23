import { describe, expect, it } from "vitest";
import { VertexAdapter, createVertexAdapter, type VertexCredentialProvider } from "./vertex.js";
import { ProviderError, isRecoverableError } from "../errors.js";
import type { LLMChatParams } from "../types.js";

function minimalParams(): LLMChatParams {
  return { messages: [], tools: [], signal: new AbortController().signal };
}

function internals(adapter: VertexAdapter): {
  projectId?: string;
  location?: string;
  credentials?: VertexCredentialProvider;
} {
  return adapter as unknown as {
    projectId?: string;
    location?: string;
    credentials?: VertexCredentialProvider;
  };
}

const fakeCredentials: VertexCredentialProvider = {
  projectId: "my-project",
  location: "us-central1",
  credentials: { type: "service_account" },
  getAccessToken: async () => ({ token: "tok", expiresAt: Date.now() + 1000 }),
};

describe("VertexAdapter constructor", () => {
  it("exposes modelName and systemPrompt", () => {
    const adapter = new VertexAdapter({
      model: "gemini-1.5-pro",
      systemPrompt: "Be brief.",
    });
    expect(adapter.modelName).toBe("gemini-1.5-pro");
    expect(adapter.systemPrompt).toBe("Be brief.");
  });

  it("stores projectId, location and credentials", () => {
    const adapter = new VertexAdapter({
      model: "gemini-1.5-pro",
      projectId: "proj-a",
      location: "europe-west1",
      credentials: fakeCredentials,
    });
    const opts = internals(adapter);
    expect(opts.projectId).toBe("proj-a");
    expect(opts.location).toBe("europe-west1");
    expect(opts.credentials).toBe(fakeCredentials);
  });

  it("leaves projectId/location/credentials undefined when omitted", () => {
    const opts = internals(new VertexAdapter({ model: "gemini-1.5-pro" }));
    expect(opts.projectId).toBeUndefined();
    expect(opts.location).toBeUndefined();
    expect(opts.credentials).toBeUndefined();
  });
});

describe("VertexAdapter.chat", () => {
  it("rejects with ProviderError naming the vertex provider", async () => {
    const adapter = new VertexAdapter({ model: "gemini-1.5-pro" });
    await expect(adapter.chat(minimalParams())).rejects.toSatisfy((error: unknown) => {
      return error instanceof ProviderError && error.provider === "vertex";
    });
  });

  it("rejects with the model in the message and code provider_error", async () => {
    const adapter = new VertexAdapter({ model: "gemini-2.0-flash" });
    try {
      await adapter.chat(minimalParams());
      expect.unreachable("chat should have thrown");
    } catch (error) {
      const providerError = error as ProviderError;
      expect(providerError.code).toBe("provider_error");
      expect(providerError.message).toContain("gemini-2.0-flash");
      expect(providerError.message).toContain("not implemented");
    }
  });

  it("is treated as recoverable when no status code is set (transient semantics)", async () => {
    const adapter = new VertexAdapter({ model: "gemini-1.5-pro" });
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

describe("createVertexAdapter", () => {
  it("creates an adapter from model and credentials", () => {
    const adapter = createVertexAdapter("gemini-1.5-pro", fakeCredentials);
    expect(adapter).toBeInstanceOf(VertexAdapter);
    expect(adapter.modelName).toBe("gemini-1.5-pro");
    expect(internals(adapter).credentials).toBe(fakeCredentials);
  });

  it("works without credentials", () => {
    const adapter = createVertexAdapter("gemini-1.5-pro");
    expect(internals(adapter).credentials).toBeUndefined();
  });
});
