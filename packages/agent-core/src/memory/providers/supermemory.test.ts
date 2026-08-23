import { describe, expect, it } from "vitest";
import { SupermemoryProvider, createSupermemoryProvider } from "./supermemory.js";
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

describe("SupermemoryProvider.search", () => {
  it("searches /v4/search with container_tag and auth header", async () => {
    const mock = makeMockFetch(200, {
      results: [{ id: "s1", content: "memory", score: 0.75 }],
    });
    const provider = new SupermemoryProvider({
      apiKey: "sm-key",
      containerTag: "tag-1",
      fetchImpl: mock.fetchImpl,
    });

    const result = await provider.search("hello", { top_k: 4 });

    const request = mock.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.supermemory.io/v4/search");
    expect(request?.headers.authorization).toBe("Bearer sm-key");
    expect(request?.body).toEqual({ query: "hello", container_tag: "tag-1", top_k: 4 });
    expect(result.entries).toEqual([{ id: "s1", content: "memory", score: 0.75 }]);
  });

  it("prefers per-call containerTag and defaults top_k to 5", async () => {
    const mock = makeMockFetch(200, { results: [] });
    const provider = new SupermemoryProvider({ containerTag: "t1", fetchImpl: mock.fetchImpl });

    await provider.search("q", { containerTag: "t2" });

    const body = mock.requests[0]?.body as Record<string, unknown>;
    expect(body.container_tag).toBe("t2");
    expect(body.top_k).toBe(5);
  });

  it("returns empty entries when results is missing", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new SupermemoryProvider({ fetchImpl: mock.fetchImpl });

    await expect(provider.search("q")).resolves.toEqual({ entries: [] });
  });

  it("throws ProviderError on non-2xx responses", async () => {
    const mock = makeMockFetch(401, { error: "unauthorized" });
    const provider = new SupermemoryProvider({ fetchImpl: mock.fetchImpl });

    try {
      await provider.search("q");
      expect.unreachable("search should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.statusCode).toBe(401);
      expect(providerError.provider).toBe("SupermemoryProvider");
      expect(providerError.message).toContain("401");
    }
  });
});

describe("SupermemoryProvider.add", () => {
  it("stores a conversation with container_tag and metadata", async () => {
    const mock = makeMockFetch(200, { id: "s2", status: "stored" });
    const provider = new SupermemoryProvider({
      containerTag: "t1",
      fetchImpl: mock.fetchImpl,
    });

    const result = await provider.add("message", { metadata: { kind: "note" } });

    expect(mock.requests[0]?.method).toBe("POST");
    expect(mock.requests[0]?.url).toBe("https://api.supermemory.io/v4/conversations");
    expect(mock.requests[0]?.body).toEqual({
      content: "message",
      container_tag: "t1",
      metadata: { kind: "note" },
    });
    expect(result).toEqual({ success: true, message: "stored", id: "s2" });
  });

  it("defaults metadata and falls back to the default message", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new SupermemoryProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.add("note");

    expect((mock.requests[0]?.body as Record<string, unknown>).metadata).toEqual({});
    expect(result).toEqual({ success: true, message: "Supermemory stored.", id: undefined });
  });
});

describe("SupermemoryProvider.delete", () => {
  it("deletes a conversation by id and URL-encodes it", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new SupermemoryProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.delete("s/1");

    expect(mock.requests[0]?.method).toBe("DELETE");
    expect(mock.requests[0]?.url).toBe("https://api.supermemory.io/v4/conversations/s%2F1");
    expect(result).toEqual({ success: true, message: "Supermemory deleted.", id: "s/1" });
  });
});

describe("SupermemoryProvider config surface", () => {
  it("exposes provider metadata", () => {
    const provider = new SupermemoryProvider();
    expect(provider.name).toBe("supermemory");
    expect(provider.displayName).toBe("Supermemory");
  });

  it("declares apiKey/baseUrl/containerTag fields in the config schema", () => {
    const schema = new SupermemoryProvider().getConfigSchema();
    expect(schema.fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["apiKey", "secret", true],
      ["baseUrl", "text", undefined],
      ["containerTag", "text", undefined],
    ]);
  });

  it("validates apiKey as required", () => {
    const provider = new SupermemoryProvider();
    expect(provider.validateConfig({}).valid).toBe(false);
    expect(provider.validateConfig({}).errors).toEqual(["apiKey is required"]);
    expect(provider.validateConfig({ apiKey: "k" }).valid).toBe(true);
    expect(provider.validateConfig({ apiKey: "" }).valid).toBe(false);
  });

  it("factory drops non-string config values", () => {
    const provider = createSupermemoryProvider({ apiKey: {}, baseUrl: 5, containerTag: [] });
    expect(provider).toBeInstanceOf(SupermemoryProvider);
    expect(provider.name).toBe("supermemory");
  });
});
