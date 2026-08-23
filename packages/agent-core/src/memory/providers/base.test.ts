import { describe, expect, it } from "vitest";
import { HttpMemoryProvider, type HttpMemoryProviderOptions } from "./base.js";
import { ProviderError } from "../../errors.js";

/** Concrete subclass exposing the protected base plumbing for testing. */
class TestProvider extends HttpMemoryProvider {
  constructor(options: HttpMemoryProviderOptions) {
    super(options);
  }

  build(path: string, init: RequestInit) {
    return this.buildRequest(path, init);
  }

  callRequest(path: string, init: RequestInit) {
    return this.request(path, init);
  }

  callPost(path: string, body: unknown) {
    return this.post(path, body);
  }

  callDel(path: string) {
    return this.del(path);
  }
}

function provider(options: Partial<HttpMemoryProviderOptions> = {}) {
  return new TestProvider({ baseUrl: "https://api.example.com", ...options });
}

describe("HttpMemoryProvider.buildRequest", () => {
  it("joins baseUrl and path with default GET method", () => {
    const req = provider().build("/v1/search", {});
    expect(req.url).toBe("https://api.example.com/v1/search");
    expect(req.method).toBe("GET");
  });

  it("strips a trailing slash from baseUrl", () => {
    const req = new TestProvider({ baseUrl: "https://api.example.com/" }).build("/v1", {});
    expect(req.url).toBe("https://api.example.com/v1");
  });

  it("sets Content-Type and merges extra headers", () => {
    const req = provider({ extraHeaders: { "X-Tenant": "t1", "X-Key": "k" } }).build("/v1", {
      headers: {},
    });
    expect(req.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Tenant": "t1",
      "X-Key": "k",
    });
  });

  it("lets extraHeaders override Content-Type", () => {
    const req = provider({ extraHeaders: { "Content-Type": "text/plain" } }).build("/v1", {});
    expect(req.headers["Content-Type"]).toBe("text/plain");
  });

  it("adds a Bearer Authorization header when apiKey is set", () => {
    const req = provider({ apiKey: "secret-key" }).build("/v1", {});
    expect(req.headers.Authorization).toBe("Bearer secret-key");
  });

  it("omits Authorization when apiKey is absent", () => {
    const req = provider().build("/v1", {});
    expect(req.headers.Authorization).toBeUndefined();
  });

  it("parses JSON string bodies into objects", () => {
    const req = provider().build("/v1", { body: '{"query":"hi"}' });
    expect(req.body).toEqual({ query: "hi" });
  });

  it("keeps non-JSON string bodies as-is", () => {
    const req = provider().build("/v1", { body: "plain text" });
    expect(req.body).toBe("plain text");
  });

  it("passes non-string bodies through unchanged", () => {
    const req = provider().build("/v1", { body: 42 as unknown as BodyInit });
    expect(req.body).toBe(42);
  });

  it("preserves the init method", () => {
    const req = provider().build("/v1", { method: "POST" });
    expect(req.method).toBe("POST");
  });
});

describe("HttpMemoryProvider.request", () => {
  it("returns the response for OK statuses", async () => {
    const fetchImpl = async () =>
      new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
    const response = await provider({ fetchImpl }).callRequest("/v1", { method: "GET" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("throws ProviderError for non-OK responses with status and body text", async () => {
    const fetchImpl = async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
    try {
      await provider({ fetchImpl }).callRequest("/v1", {});
      expect.unreachable("request should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.statusCode).toBe(429);
      expect(providerError.code).toBe("provider_error");
      // constructor.name of the concrete subclass is used as the provider label
      expect(providerError.provider).toBe("TestProvider");
      expect(providerError.message).toContain("429");
      expect(providerError.message).toContain("rate limited");
    }
  });

  it("treats 5xx responses as recoverable and 4xx as not", async () => {
    const make = (status: number) =>
      provider({
        fetchImpl: async () => new Response("x", { status, statusText: "err" }),
      });
    await expect(make(500).callRequest("/v1", {})).rejects.toSatisfy(
      (error: unknown) => error instanceof ProviderError && error.recoverable === true,
    );
    await expect(make(503).callRequest("/v1", {})).rejects.toSatisfy(
      (error: unknown) => error instanceof ProviderError && error.recoverable === true,
    );
    await expect(make(400).callRequest("/v1", {})).rejects.toSatisfy(
      (error: unknown) => error instanceof ProviderError && error.recoverable === false,
    );
    await expect(make(429).callRequest("/v1", {})).rejects.toSatisfy(
      (error: unknown) => error instanceof ProviderError && error.recoverable === true,
    );
  });

  it("propagates network failures (rejected fetch)", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(provider({ fetchImpl }).callRequest("/v1", {})).rejects.toThrow("fetch failed");
  });
});

describe("HttpMemoryProvider.post / del helpers", () => {
  it("post sends JSON-serialized body with POST method", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response('{"id":"x"}', { status: 200 });
    };
    const p = provider({ fetchImpl });
    const response = await p.callPost("/v1/items", { content: "note" });
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe('{"content":"note"}');
    expect(capturedInit?.headers).toBeInstanceOf(Headers);
    expect(new Headers(capturedInit?.headers).get("Content-Type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ id: "x" });
  });

  it("del sends DELETE method", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl = "";
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedInit = init;
      return new Response('{"ok":true}', { status: 200 });
    };
    const p = provider({ fetchImpl });
    await p.callDel("/v1/items/42");
    expect(capturedUrl).toBe("https://api.example.com/v1/items/42");
    expect(capturedInit?.method).toBe("DELETE");
  });
});
