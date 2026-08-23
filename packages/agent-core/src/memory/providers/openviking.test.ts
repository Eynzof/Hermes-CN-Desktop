import { describe, expect, it } from "vitest";
import { OpenVikingProvider, createOpenVikingProvider } from "./openviking.js";
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

describe("OpenViking SSRF guard", () => {
  it.each([
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://127.1.2.3",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://172.31.255.255",
    "http://192.168.1.1",
    "http://0.0.0.0",
    "http://[::1]:8080",
    "http://[::1]",
    "http://[::]",
    // Link-local range: AWS/GCP/Azure/Aliyun metadata endpoints live here.
    "http://169.254.169.254",
    "http://169.254.0.1",
    // Carrier-grade NAT range.
    "http://100.64.0.1",
    "http://100.127.255.254",
    // IPv4-mapped IPv6 bypass attempts.
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:10.0.0.1]",
    "http://[::ffff:169.254.169.254]",
  ])("blocks loopback/private endpoint %s", (endpoint) => {
    expect(() => new OpenVikingProvider({ endpoint })).toThrow(ProviderError);
  });

  it("throws ProviderError with the openviking provider name for blocked endpoints", () => {
    try {
      new OpenVikingProvider({ endpoint: "http://127.0.0.1" });
      expect.unreachable("constructor should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.provider).toBe("openviking");
      expect(providerError.message).toContain("blocked");
    }
  });

  it("rejects non-http(s) protocols", () => {
    expect(() => new OpenVikingProvider({ endpoint: "ftp://example.com" })).toThrow(/http\/https/);
    expect(() => new OpenVikingProvider({ endpoint: "file:///etc/passwd" })).toThrow(ProviderError);
  });

  it("rejects unparsable endpoints", () => {
    expect(() => new OpenVikingProvider({ endpoint: "not a url" })).toThrow(/Invalid OpenViking endpoint/);
  });

  it("allows public https endpoints and strips a trailing slash", async () => {
    const mock = makeMockFetch(200, { results: [] });
    const provider = new OpenVikingProvider({
      endpoint: "https://ov.example.com/",
      fetchImpl: mock.fetchImpl,
    });
    await provider.search("q");
    expect(mock.requests[0]?.url).toBe("https://ov.example.com/api/search");
  });

  it("allows uncommon-but-public hosts (subdomains of private prefixes are not blocked)", () => {
    // The guard anchors on the exact hostname, so a public name containing a
    // private-looking segment must be allowed.
    expect(() => new OpenVikingProvider({ endpoint: "https://localhost.example.com" })).not.toThrow();
    expect(() => new OpenVikingProvider({ endpoint: "https://192.168.1.1.nip.io" })).not.toThrow();
  });

  it("collects guard errors in validateConfig instead of throwing", () => {
    const provider = new OpenVikingProvider({ endpoint: "https://ok.example.com" });
    const validation = provider.validateConfig({ endpoint: "http://10.0.0.5" });
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes("blocked"))).toBe(true);
  });
});

describe("OpenVikingProvider.search", () => {
  it("posts query/top_k/filters to /api/search with auth header", async () => {
    const mock = makeMockFetch(200, {
      results: [{ id: "v1", content: "match", score: 0.8 }],
    });
    const provider = new OpenVikingProvider({
      endpoint: "https://ov.example.com",
      apiKey: "ov-key",
      fetchImpl: mock.fetchImpl,
    });

    const result = await provider.search("hello", { top_k: 3, filters: { tag: "x" } });

    const request = mock.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://ov.example.com/api/search");
    expect(request?.headers.authorization).toBe("Bearer ov-key");
    expect(request?.body).toEqual({ query: "hello", top_k: 3, filters: { tag: "x" } });
    expect(result.entries).toEqual([{ id: "v1", content: "match", score: 0.8 }]);
  });

  it("defaults top_k to 5 and filters to {}", async () => {
    const mock = makeMockFetch(200, { results: [] });
    const provider = new OpenVikingProvider({ fetchImpl: mock.fetchImpl });

    await provider.search("q");

    expect(mock.requests[0]?.body).toEqual({ query: "q", top_k: 5, filters: {} });
  });

  it("returns empty entries when results is missing", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new OpenVikingProvider({ fetchImpl: mock.fetchImpl });

    await expect(provider.search("q")).resolves.toEqual({ entries: [] });
  });

  it("throws ProviderError on non-2xx responses", async () => {
    const mock = makeMockFetch(502, { error: "bad gateway" });
    const provider = new OpenVikingProvider({ fetchImpl: mock.fetchImpl });

    try {
      await provider.search("q");
      expect.unreachable("search should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.statusCode).toBe(502);
      expect(providerError.provider).toBe("OpenVikingProvider");
      expect(providerError.message).toContain("502");
    }
  });
});

describe("OpenVikingProvider.add", () => {
  it("posts content/tags to /api/remember", async () => {
    const mock = makeMockFetch(200, { id: "v2", status: "remembered" });
    const provider = new OpenVikingProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.add("note", { tags: ["work", "ideas"] });

    expect(mock.requests[0]?.method).toBe("POST");
    expect(mock.requests[0]?.url).toBe("https://openviking.example.com/api/remember");
    expect(mock.requests[0]?.body).toEqual({ content: "note", tags: ["work", "ideas"] });
    expect(result).toEqual({ success: true, message: "remembered", id: "v2" });
  });

  it("defaults tags to [] and message to the fallback", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new OpenVikingProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.add("note");

    expect((mock.requests[0]?.body as Record<string, unknown>).tags).toEqual([]);
    expect(result).toEqual({ success: true, message: "OpenViking memory added.", id: undefined });
  });
});

describe("OpenVikingProvider.delete", () => {
  it("deletes by id and URL-encodes it", async () => {
    const mock = makeMockFetch(200, {});
    const provider = new OpenVikingProvider({ fetchImpl: mock.fetchImpl });

    const result = await provider.delete("v/1");

    expect(mock.requests[0]?.method).toBe("DELETE");
    expect(mock.requests[0]?.url).toBe("https://openviking.example.com/api/memories/v%2F1");
    expect(result).toEqual({ success: true, message: "OpenViking memory deleted.", id: "v/1" });
  });
});

describe("OpenVikingProvider config surface", () => {
  it("exposes provider metadata", () => {
    const provider = new OpenVikingProvider();
    expect(provider.name).toBe("openviking");
    expect(provider.displayName).toBe("OpenViking");
  });

  it("declares endpoint/apiKey fields in the config schema", () => {
    const schema = new OpenVikingProvider().getConfigSchema();
    expect(schema.fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["endpoint", "text", true],
      ["apiKey", "secret", undefined],
    ]);
  });

  it("validates endpoint as required and reachable", () => {
    const provider = new OpenVikingProvider();
    expect(provider.validateConfig({}).valid).toBe(false);
    expect(provider.validateConfig({}).errors).toEqual(["endpoint is required"]);
    expect(provider.validateConfig({ endpoint: "https://ok.example.com" }).valid).toBe(true);
    expect(provider.validateConfig({ endpoint: "http://192.168.0.2" }).valid).toBe(false);
  });

  it("defaults to a public example endpoint", () => {
    const provider = createOpenVikingProvider({});
    expect(provider.name).toBe("openviking");
  });

  it("factory drops non-string config values", () => {
    const provider = createOpenVikingProvider({ endpoint: 42, apiKey: [] });
    expect(provider).toBeInstanceOf(OpenVikingProvider);
    expect(provider.name).toBe("openviking");
  });
});
