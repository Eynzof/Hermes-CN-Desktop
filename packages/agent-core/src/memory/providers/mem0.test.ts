import { describe, expect, it } from "vitest";
import { Mem0Provider, createMem0Provider } from "./mem0.js";
import { ProviderError } from "../../errors.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeMockFetch(status = 200, responseBody: unknown = {}): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body) as unknown;
      } catch {
        // keep raw
      }
    }
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()) as Record<string, string>,
      body,
    });
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        statusText: status >= 400 ? "Error" : "OK",
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { fetchImpl, requests };
}

describe("Mem0Provider.search", () => {
  it("posts to /v1/memories/search with X-API-Key and user_id", async () => {
    const mock = makeMockFetch(200, [{ id: "m1", memory: "hello", score: 0.9 }]);
    const provider = new Mem0Provider({ apiKey: "mem0-key", userId: "u1", fetchImpl: mock.fetchImpl });

    const result = await provider.search("hello");

    const request = mock.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.mem0.ai/v1/memories/search");
    expect(request?.headers["x-api-key"]).toBe("mem0-key");
    expect(request?.headers.authorization).toBe("Bearer mem0-key");
    expect(request?.body).toEqual({ query: "hello", user_id: "u1", top_k: 5 });
    expect(result.entries).toEqual([{ id: "m1", content: "hello", score: 0.9 }]);
  });

  it("overrides user_id and top_k per call", async () => {
    const mock = makeMockFetch(200, []);
    const provider = new Mem0Provider({ userId: "u1", fetchImpl: mock.fetchImpl });

    await provider.search("q", { userId: "u2", top_k: 10 });

    const body = mock.requests[0]?.body as Record<string, unknown>;
    expect(body.user_id).toBe("u2");
    expect(body.top_k).toBe(10);
  });

  it("omits user_id when neither config nor options provide one", async () => {
    const mock = makeMockFetch(200, []);
    const provider = new Mem0Provider({ fetchImpl: mock.fetchImpl });

    await provider.search("q");

    const body = mock.requests[0]?.body as Record<string, unknown>;
    expect(body.user_id).toBeUndefined();
  });

  it("returns empty entries for an empty array or null body", async () => {
    const empty = makeMockFetch(200, []);
    const provider = new Mem0Provider({ fetchImpl: empty.fetchImpl });
    await expect(provider.search("q")).resolves.toEqual({ entries: [] });

    const nullBody = makeMockFetch(200, null);
    const provider2 = new Mem0Provider({ fetchImpl: nullBody.fetchImpl });
    await expect(provider2.search("q")).resolves.toEqual({ entries: [] });
  });

  it("throws ProviderError on non-2xx responses", async () => {
    const mock = makeMockFetch(401, { error: "unauthorized" });
    const provider = new Mem0Provider({ fetchImpl: mock.fetchImpl });

    try {
      await provider.search("q");
      expect.unreachable("search should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.statusCode).toBe(401);
      expect(providerError.provider).toBe("Mem0Provider");
      expect(providerError.message).toContain("401");
    }
  });
});

describe("Mem0Provider.add", () => {
  it("posts content/user_id/metadata to /v1/memories", async () => {
    const mock = makeMockFetch(200, { id: "m2", message: "created" });
    const provider = new Mem0Provider({ apiKey: "k", userId: "u1", fetchImpl: mock.fetchImpl });

    const result = await provider.add("note", { metadata: { tag: "x" } });

    expect(mock.requests[0]?.method).toBe("POST");
    expect(mock.requests[0]?.url).toBe("https://api.mem0.ai/v1/memories");
    expect(mock.requests[0]?.body).toEqual({ content: "note", user_id: "u1", metadata: { tag: "x" } });
    expect(result).toEqual({ success: true, message: "created", id: "m2" });
  });

  it("defaults metadata and falls back to the default message", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new Mem0Provider({ fetchImpl: mock.fetchImpl });

    const result = await provider.add("note");

    const body = mock.requests[0]?.body as Record<string, unknown>;
    expect(body.metadata).toEqual({});
    expect(result).toEqual({ success: true, message: "Mem0 memory added.", id: undefined });
  });
});

describe("Mem0Provider.delete", () => {
  it("deletes by id and URL-encodes it", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new Mem0Provider({ fetchImpl: mock.fetchImpl });

    const result = await provider.delete("m/1");

    expect(mock.requests[0]?.method).toBe("DELETE");
    expect(mock.requests[0]?.url).toBe("https://api.mem0.ai/v1/memories/m%2F1");
    expect(result).toEqual({ success: true, message: "Mem0 memory deleted.", id: "m/1" });
  });
});

describe("Mem0Provider config surface", () => {
  it("exposes provider metadata", () => {
    const provider = new Mem0Provider();
    expect(provider.name).toBe("mem0");
    expect(provider.displayName).toBe("Mem0");
  });

  it("declares apiKey/baseUrl/userId fields in the config schema", () => {
    const schema = new Mem0Provider().getConfigSchema();
    expect(schema.fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["apiKey", "secret", true],
      ["baseUrl", "text", undefined],
      ["userId", "text", undefined],
    ]);
  });

  it("validates apiKey as required", () => {
    const provider = new Mem0Provider();
    expect(provider.validateConfig({}).valid).toBe(false);
    expect(provider.validateConfig({ apiKey: "k" }).valid).toBe(true);
    expect(provider.validateConfig({ apiKey: "" }).valid).toBe(false);
    expect(provider.validateConfig({ apiKey: 7 }).valid).toBe(false);
  });

  it("always sends the X-API-Key header even when empty (documented stub behavior)", async () => {
    const mock = makeMockFetch(200, []);
    const provider = new Mem0Provider({ fetchImpl: mock.fetchImpl });
    await provider.search("q");
    expect(mock.requests[0]?.headers["x-api-key"]).toBe("");
  });

  it("factory drops non-string config values", () => {
    const provider = createMem0Provider({ apiKey: 42, baseUrl: null, userId: {} });
    expect(provider).toBeInstanceOf(Mem0Provider);
    expect(provider.name).toBe("mem0");
  });
});
