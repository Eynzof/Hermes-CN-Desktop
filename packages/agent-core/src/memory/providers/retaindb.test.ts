import { describe, expect, it } from "vitest";
import { RetainDBProvider, createRetainDBProvider } from "./retaindb.js";
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

describe("RetainDBProvider.search", () => {
  it("searches with query/top_k and auth header", async () => {
    const mock = makeMockFetch(200, {
      results: [{ id: "r1", content: "resource", score: 0.85 }],
    });
    const provider = new RetainDBProvider({ apiKey: "ret-key", fetchImpl: mock.fetchImpl });

    const result = await provider.search("hello");

    const request = mock.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.retaindb.io/v1/search");
    expect(request?.headers.authorization).toBe("Bearer ret-key");
    expect(request?.body).toEqual({ query: "hello", top_k: 5 });
    expect(result.entries).toEqual([{ id: "r1", content: "resource", score: 0.85 }]);
  });

  it("includes context in the body only when provided", async () => {
    const withContext = makeMockFetch(200, { results: [] });
    const provider = new RetainDBProvider({ fetchImpl: withContext.fetchImpl });
    await provider.search("q", { context: "project-x", top_k: 3 });
    expect(withContext.requests[0]?.body).toEqual({
      query: "q",
      top_k: 3,
      context: "project-x",
    });

    const withoutContext = makeMockFetch(200, { results: [] });
    const provider2 = new RetainDBProvider({ fetchImpl: withoutContext.fetchImpl });
    await provider2.search("q");
    const body = withoutContext.requests[0]?.body as Record<string, unknown>;
    expect(body.context).toBeUndefined();
  });

  it("returns empty entries when results is missing", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new RetainDBProvider({ fetchImpl: mock.fetchImpl });

    await expect(provider.search("q")).resolves.toEqual({ entries: [] });
  });

  it("throws ProviderError on non-2xx responses", async () => {
    const mock = makeMockFetch(500, { error: "boom" });
    const provider = new RetainDBProvider({ fetchImpl: mock.fetchImpl });

    try {
      await provider.search("q");
      expect.unreachable("search should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.statusCode).toBe(500);
      expect(providerError.provider).toBe("RetainDBProvider");
      expect(providerError.message).toContain("500");
    }
  });
});

describe("RetainDBProvider.add", () => {
  it("remembers content with context", async () => {
    const mock = makeMockFetch(200, { id: "r2", status: "retained" });
    const provider = new RetainDBProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.add("resource", { context: "proj" });

    expect(mock.requests[0]?.method).toBe("POST");
    expect(mock.requests[0]?.url).toBe("https://api.retaindb.io/v1/remember");
    expect(mock.requests[0]?.body).toEqual({ content: "resource", context: "proj" });
    expect(result).toEqual({ success: true, message: "retained", id: "r2" });
  });

  it("defaults context to an empty string and message to the fallback", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new RetainDBProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.add("note");

    expect((mock.requests[0]?.body as Record<string, unknown>).context).toBe("");
    expect(result).toEqual({ success: true, message: "RetainDB memory retained.", id: undefined });
  });
});

describe("RetainDBProvider.delete", () => {
  it("deletes by id and URL-encodes it", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new RetainDBProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.delete("r/1");

    expect(mock.requests[0]?.method).toBe("DELETE");
    expect(mock.requests[0]?.url).toBe("https://api.retaindb.io/v1/memories/r%2F1");
    expect(result).toEqual({ success: true, message: "RetainDB memory deleted.", id: "r/1" });
  });
});

describe("RetainDBProvider config surface", () => {
  it("exposes provider metadata", () => {
    const provider = new RetainDBProvider();
    expect(provider.name).toBe("retaindb");
    expect(provider.displayName).toBe("RetainDB");
  });

  it("declares apiKey/baseUrl fields in the config schema", () => {
    const schema = new RetainDBProvider().getConfigSchema();
    expect(schema.fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["apiKey", "secret", true],
      ["baseUrl", "text", undefined],
    ]);
  });

  it("validates apiKey as required", () => {
    const provider = new RetainDBProvider();
    expect(provider.validateConfig({}).valid).toBe(false);
    expect(provider.validateConfig({}).errors).toEqual(["apiKey is required"]);
    expect(provider.validateConfig({ apiKey: "k" }).valid).toBe(true);
    expect(provider.validateConfig({ apiKey: null }).valid).toBe(false);
  });

  it("factory drops non-string config values", () => {
    const provider = createRetainDBProvider({ apiKey: ["k"], baseUrl: 1 });
    expect(provider).toBeInstanceOf(RetainDBProvider);
    expect(provider.name).toBe("retaindb");
  });
});
