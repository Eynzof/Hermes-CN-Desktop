import { describe, expect, it } from "vitest";
import { HonchoProvider, createHonchoProvider } from "./honcho.js";
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

describe("HonchoProvider.search", () => {
  it("posts query with default top_k to the session search endpoint", async () => {
    const mock = makeMockFetch(200, {
      results: [{ id: "m1", content: "hello", score: 0.9 }],
    });
    const provider = new HonchoProvider({ apiKey: "k", fetchImpl: mock.fetchImpl });

    const result = await provider.search("hello");

    expect(mock.requests[0]?.method).toBe("POST");
    expect(mock.requests[0]?.url).toBe("https://api.honcho.dev/v1/sessions/default/search");
    expect(mock.requests[0]?.body).toEqual({ query: "hello", top_k: 5 });
    expect(mock.requests[0]?.headers.authorization).toBe("Bearer k");
    expect(result.entries).toEqual([{ id: "m1", content: "hello", score: 0.9 }]);
  });

  it("uses the configured sessionId by default", async () => {
    const mock = makeMockFetch(200, { results: [] });
    const provider = new HonchoProvider({ sessionId: "s-42", fetchImpl: mock.fetchImpl });

    await provider.search("q");

    expect(mock.requests[0]?.url).toBe("https://api.honcho.dev/v1/sessions/s-42/search");
  });

  it("prefers the per-call sessionId option over the configured one", async () => {
    const mock = makeMockFetch(200, { results: [] });
    const provider = new HonchoProvider({ sessionId: "s-42", fetchImpl: mock.fetchImpl });

    await provider.search("q", { sessionId: "other" });

    expect(mock.requests[0]?.url).toBe("https://api.honcho.dev/v1/sessions/other/search");
  });

  it("URL-encodes session ids", async () => {
    const mock = makeMockFetch(200, { results: [] });
    const provider = new HonchoProvider({ fetchImpl: mock.fetchImpl });

    await provider.search("q", { sessionId: "a/b c" });

    expect(mock.requests[0]?.url).toBe("https://api.honcho.dev/v1/sessions/a%2Fb%20c/search");
  });

  it("passes top_k through from options", async () => {
    const mock = makeMockFetch(200, { results: [] });
    const provider = new HonchoProvider({ fetchImpl: mock.fetchImpl });

    await provider.search("q", { top_k: 20 });

    expect((mock.requests[0]?.body as Record<string, unknown>).top_k).toBe(20);
  });

  it("returns empty entries when the results key is missing", async () => {
    const mock = makeMockFetch(200, { other: true });
    const provider = new HonchoProvider({ fetchImpl: mock.fetchImpl });

    await expect(provider.search("q")).resolves.toEqual({ entries: [] });
  });

  it("throws ProviderError on non-2xx responses", async () => {
    const mock = makeMockFetch(500, { error: "boom" });
    const provider = new HonchoProvider({ fetchImpl: mock.fetchImpl });

    try {
      await provider.search("q");
      expect.unreachable("search should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.statusCode).toBe(500);
      expect(providerError.provider).toBe("HonchoProvider");
      expect(providerError.message).toContain("500");
    }
  });
});

describe("HonchoProvider.add", () => {
  it("posts content/role/metadata to the session messages endpoint", async () => {
    const mock = makeMockFetch(200, { id: "m2", message: "stored" });
    const provider = new HonchoProvider({ apiKey: "k", fetchImpl: mock.fetchImpl });

    const result = await provider.add("remember this", { metadata: { source: "test" } });

    expect(mock.requests[0]?.method).toBe("POST");
    expect(mock.requests[0]?.url).toBe("https://api.honcho.dev/v1/sessions/default/messages");
    expect(mock.requests[0]?.body).toEqual({
      content: "remember this",
      role: "user",
      metadata: { source: "test" },
    });
    expect(result).toEqual({ success: true, message: "stored", id: "m2" });
  });

  it("defaults metadata to an empty object and message to the fallback", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new HonchoProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.add("note");

    expect((mock.requests[0]?.body as Record<string, unknown>).metadata).toEqual({});
    expect(result).toEqual({ success: true, message: "Honcho memory added.", id: undefined });
  });

  it("uses the per-call sessionId for add", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new HonchoProvider({ fetchImpl: mock.fetchImpl });

    await provider.add("note", { sessionId: "s/1" });

    expect(mock.requests[0]?.url).toBe("https://api.honcho.dev/v1/sessions/s%2F1/messages");
  });
});

describe("HonchoProvider.delete", () => {
  it("deletes by id within the session and URL-encodes the id", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new HonchoProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.delete("m/1");

    expect(mock.requests[0]?.method).toBe("DELETE");
    expect(mock.requests[0]?.url).toBe("https://api.honcho.dev/v1/sessions/default/messages/m%2F1");
    expect(result).toEqual({ success: true, message: "Honcho memory deleted.", id: "m/1" });
  });

  it("uses the per-call sessionId for delete", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new HonchoProvider({ sessionId: "s-1", fetchImpl: mock.fetchImpl });

    await provider.delete("m1", { sessionId: "s-2" });

    expect(mock.requests[0]?.url).toBe("https://api.honcho.dev/v1/sessions/s-2/messages/m1");
  });
});

describe("HonchoProvider config surface", () => {
  it("exposes provider metadata", () => {
    const provider = new HonchoProvider();
    expect(provider.name).toBe("honcho");
    expect(provider.displayName).toBe("Honcho");
    expect(provider.description).toContain("Dialectic");
  });

  it("declares apiKey/baseUrl/sessionId fields in the config schema", () => {
    const schema = new HonchoProvider().getConfigSchema();
    expect(schema.fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["apiKey", "secret", true],
      ["baseUrl", "text", undefined],
      ["sessionId", "text", undefined],
    ]);
  });

  it("validates apiKey as required", () => {
    const provider = new HonchoProvider();
    expect(provider.validateConfig({}).valid).toBe(false);
    expect(provider.validateConfig({}).errors).toEqual(["apiKey is required"]);
    expect(provider.validateConfig({ apiKey: "k" }).valid).toBe(true);
    expect(provider.validateConfig({ apiKey: 42 }).valid).toBe(false);
  });

  it("factory drops non-string config values", () => {
    const provider = createHonchoProvider({
      apiKey: 42,
      baseUrl: 123,
      sessionId: null,
      fetchImpl: "not-a-function",
    });
    expect(provider).toBeInstanceOf(HonchoProvider);
    expect(provider.name).toBe("honcho");
  });
});
