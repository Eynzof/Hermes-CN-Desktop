import { describe, expect, it } from "vitest";
import { HindsightProvider, createHindsightProvider } from "./hindsight.js";
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

describe("HindsightProvider.search", () => {
  it("recalls with query/bank_id/top_k and auth header", async () => {
    const mock = makeMockFetch(200, {
      results: [{ id: "h1", content: "insight", score: 0.7 }],
    });
    const provider = new HindsightProvider({
      apiKey: "hind-key",
      bankId: "bank-1",
      fetchImpl: mock.fetchImpl,
    });

    const result = await provider.search("hello", { top_k: 8 });

    const request = mock.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.hindsight.io/api/recall");
    expect(request?.headers.authorization).toBe("Bearer hind-key");
    expect(request?.body).toEqual({ query: "hello", bank_id: "bank-1", top_k: 8 });
    expect(result.entries).toEqual([{ id: "h1", content: "insight", score: 0.7 }]);
  });

  it("defaults bank_id to undefined and top_k to 5", async () => {
    const mock = makeMockFetch(200, { results: [] });
    const provider = new HindsightProvider({ fetchImpl: mock.fetchImpl });

    await provider.search("q");

    const body = mock.requests[0]?.body as Record<string, unknown>;
    expect(body.bank_id).toBeUndefined();
    expect(body.top_k).toBe(5);
  });

  it("prefers per-call bankId over configured bankId", async () => {
    const mock = makeMockFetch(200, { results: [] });
    const provider = new HindsightProvider({ bankId: "b1", fetchImpl: mock.fetchImpl });

    await provider.search("q", { bankId: "b2" });

    expect((mock.requests[0]?.body as Record<string, unknown>).bank_id).toBe("b2");
  });

  it("returns empty entries when results is missing", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new HindsightProvider({ fetchImpl: mock.fetchImpl });

    await expect(provider.search("q")).resolves.toEqual({ entries: [] });
  });

  it("throws ProviderError on non-2xx responses", async () => {
    const mock = makeMockFetch(403, { error: "forbidden" });
    const provider = new HindsightProvider({ fetchImpl: mock.fetchImpl });

    try {
      await provider.search("q");
      expect.unreachable("search should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.statusCode).toBe(403);
      expect(providerError.provider).toBe("HindsightProvider");
      expect(providerError.message).toContain("403");
    }
  });
});

describe("HindsightProvider.add", () => {
  it("retains content with bank_id and metadata", async () => {
    const mock = makeMockFetch(200, { id: "h2", status: "retained" });
    const provider = new HindsightProvider({ bankId: "b1", fetchImpl: mock.fetchImpl });

    const result = await provider.add("insight", { metadata: { source: "x" } });

    expect(mock.requests[0]?.method).toBe("POST");
    expect(mock.requests[0]?.url).toBe("https://api.hindsight.io/api/retain");
    expect(mock.requests[0]?.body).toEqual({
      content: "insight",
      bank_id: "b1",
      metadata: { source: "x" },
    });
    expect(result).toEqual({ success: true, message: "retained", id: "h2" });
  });

  it("defaults metadata and falls back to the default message", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new HindsightProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.add("note");

    expect((mock.requests[0]?.body as Record<string, unknown>).metadata).toEqual({});
    expect(result).toEqual({ success: true, message: "Hindsight memory retained.", id: undefined });
  });
});

describe("HindsightProvider.delete", () => {
  it("deletes by id and URL-encodes it", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new HindsightProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.delete("h/1");

    expect(mock.requests[0]?.method).toBe("DELETE");
    expect(mock.requests[0]?.url).toBe("https://api.hindsight.io/api/memories/h%2F1");
    expect(result).toEqual({ success: true, message: "Hindsight memory deleted.", id: "h/1" });
  });
});

describe("HindsightProvider config surface", () => {
  it("exposes provider metadata", () => {
    const provider = new HindsightProvider();
    expect(provider.name).toBe("hindsight");
    expect(provider.displayName).toBe("Hindsight");
  });

  it("declares apiKey/baseUrl/bankId fields in the config schema", () => {
    const schema = new HindsightProvider().getConfigSchema();
    expect(schema.fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["apiKey", "secret", true],
      ["baseUrl", "text", undefined],
      ["bankId", "text", undefined],
    ]);
  });

  it("validates apiKey as required", () => {
    const provider = new HindsightProvider();
    expect(provider.validateConfig({}).valid).toBe(false);
    expect(provider.validateConfig({}).errors).toEqual(["apiKey is required"]);
    expect(provider.validateConfig({ apiKey: "k" }).valid).toBe(true);
    expect(provider.validateConfig({ apiKey: false }).valid).toBe(false);
  });

  it("factory drops non-string config values", () => {
    const provider = createHindsightProvider({ apiKey: 1, baseUrl: {}, bankId: [] });
    expect(provider).toBeInstanceOf(HindsightProvider);
    expect(provider.name).toBe("hindsight");
  });
});
