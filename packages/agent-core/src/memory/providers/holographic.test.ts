import { describe, expect, it } from "vitest";
import { HolographicProvider, createHolographicProvider } from "./holographic.js";
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

describe("HolographicProvider.search", () => {
  it("searches the local endpoint with query/top_k", async () => {
    const mock = makeMockFetch(200, {
      results: [{ id: "g1", content: "fact", score: 0.6 }],
    });
    const provider = new HolographicProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.search("hello", { top_k: 12 });

    const request = mock.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("http://localhost:9121/search");
    expect(request?.body).toEqual({ query: "hello", top_k: 12 });
    expect(result.entries).toEqual([{ id: "g1", content: "fact", score: 0.6 }]);
  });

  it("defaults top_k to 5 and returns empty entries for missing results", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new HolographicProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.search("q");

    expect((mock.requests[0]?.body as Record<string, unknown>).top_k).toBe(5);
    expect(result.entries).toEqual([]);
  });

  it("supports a custom baseUrl without trailing slash", async () => {
    const mock = makeMockFetch(200, { results: [] });
    const provider = new HolographicProvider({
      baseUrl: "http://localhost:9121/",
      fetchImpl: mock.fetchImpl,
    });
    await provider.search("q");
    expect(mock.requests[0]?.url).toBe("http://localhost:9121/search");
  });

  it("throws ProviderError on non-2xx responses", async () => {
    const mock = makeMockFetch(503, { error: "down" });
    const provider = new HolographicProvider({ fetchImpl: mock.fetchImpl });

    try {
      await provider.search("q");
      expect.unreachable("search should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.statusCode).toBe(503);
      expect(providerError.provider).toBe("HolographicProvider");
      expect(providerError.message).toContain("503");
    }
  });
});

describe("HolographicProvider.add", () => {
  it("stores a fact with metadata at /facts", async () => {
    const mock = makeMockFetch(200, { id: "g2", status: "stored" });
    const provider = new HolographicProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.add("fact", { metadata: { source: "note" } });

    expect(mock.requests[0]?.method).toBe("POST");
    expect(mock.requests[0]?.url).toBe("http://localhost:9121/facts");
    expect(mock.requests[0]?.body).toEqual({ content: "fact", metadata: { source: "note" } });
    expect(result).toEqual({ success: true, message: "stored", id: "g2" });
  });

  it("defaults metadata and falls back to the default message", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new HolographicProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.add("note");

    expect((mock.requests[0]?.body as Record<string, unknown>).metadata).toEqual({});
    expect(result).toEqual({ success: true, message: "Holographic fact stored.", id: undefined });
  });
});

describe("HolographicProvider.delete", () => {
  it("deletes a fact by id and URL-encodes it", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new HolographicProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.delete("g/1");

    expect(mock.requests[0]?.method).toBe("DELETE");
    expect(mock.requests[0]?.url).toBe("http://localhost:9121/facts/g%2F1");
    expect(result).toEqual({ success: true, message: "Holographic fact deleted.", id: "g/1" });
  });
});

describe("HolographicProvider config surface", () => {
  it("exposes provider metadata", () => {
    const provider = new HolographicProvider();
    expect(provider.name).toBe("holographic");
    expect(provider.displayName).toBe("Holographic");
    expect(provider.description).toContain("FTS5");
  });

  it("declares the baseUrl field in the config schema", () => {
    const schema = new HolographicProvider().getConfigSchema();
    expect(schema.fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["baseUrl", "text", undefined],
    ]);
  });

  it("always validates as valid (local store has no credentials)", () => {
    const provider = new HolographicProvider();
    expect(provider.validateConfig()).toEqual({ valid: true, errors: [] });
  });

  it("factory drops non-string config values", () => {
    const provider = createHolographicProvider({ baseUrl: 42, fetchImpl: "nope" });
    expect(provider).toBeInstanceOf(HolographicProvider);
    expect(provider.name).toBe("holographic");
  });
});
