import { describe, expect, it } from "vitest";
import {
  createHonchoProvider,
  createOpenVikingProvider,
  createMem0Provider,
  createHindsightProvider,
  createHolographicProvider,
  createRetainDBProvider,
  createByteRoverProvider,
  createSupermemoryProvider,
  type HttpMemoryRequest,
} from "./index.js";

/**
 * Capture the last HTTP request sent by a provider and return a stub Response.
 * The request record is exposed through a getter so mutations are visible.
 */
function makeMockFetch(responseBody: unknown): {
  fetchImpl: typeof fetch;
  readonly lastRequest: HttpMemoryRequest | undefined;
} {
  let captured: HttpMemoryRequest | undefined;

  const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof _input === "string" ? _input : _input.toString();
    const body: unknown =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : init?.body;
    captured = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        new Headers(init?.headers).entries(),
      ) as Record<string, string>,
      body,
    };
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  return {
    fetchImpl,
    get lastRequest() {
      return captured;
    },
  };
}

const mockSearchResponse = {
  results: [{ id: "m1", content: "hello world", score: 0.95 }],
};

const mockAddResponse = { id: "m2", status: "added" };

const mockDeleteResponse = { status: "deleted" };

describe("Honcho provider", () => {
  it("searches with session id and query", async () => {
    const mock = makeMockFetch(mockSearchResponse);
    const provider = createHonchoProvider({
      apiKey: "honcho-key",
      sessionId: "s1",
      fetchImpl: mock.fetchImpl,
    });

    const result = await provider.search("hello");

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("https://api.honcho.dev/v1/sessions/s1/search");
    expect((mock.lastRequest?.body as Record<string, unknown>).query).toBe("hello");
    expect(mock.lastRequest?.headers.authorization).toBe("Bearer honcho-key");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe("m1");
  });

  it("adds a message in a session", async () => {
    const mock = makeMockFetch(mockAddResponse);
    const provider = createHonchoProvider({ apiKey: "honcho-key", fetchImpl: mock.fetchImpl });

    const result = await provider.add("remember this");

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("https://api.honcho.dev/v1/sessions/default/messages");
    expect((mock.lastRequest?.body as Record<string, unknown>).content).toBe("remember this");
    expect(result.id).toBe("m2");
  });

  it("deletes by id", async () => {
    const mock = makeMockFetch(mockDeleteResponse);
    const provider = createHonchoProvider({ apiKey: "honcho-key", fetchImpl: mock.fetchImpl });

    const result = await provider.delete("m1");

    expect(mock.lastRequest?.method).toBe("DELETE");
    expect(mock.lastRequest?.url).toBe("https://api.honcho.dev/v1/sessions/default/messages/m1");
    expect(result.success).toBe(true);
  });

  it("validates config requires apiKey", () => {
    const provider = createHonchoProvider({});
    const validation = provider.validateConfig({});
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("apiKey is required");
  });
});

describe("OpenViking provider", () => {
  it("searches with query and top_k", async () => {
    const mock = makeMockFetch(mockSearchResponse);
    const provider = createOpenVikingProvider({
      endpoint: "https://ov.example.com",
      apiKey: "ov-key",
      fetchImpl: mock.fetchImpl,
    });

    await provider.search("hello", { top_k: 3 });

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("https://ov.example.com/api/search");
    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body.query).toBe("hello");
    expect(body.top_k).toBe(3);
    expect(mock.lastRequest?.headers.authorization).toBe("Bearer ov-key");
  });

  it("adds with tags", async () => {
    const mock = makeMockFetch(mockAddResponse);
    const provider = createOpenVikingProvider({ endpoint: "https://ov.example.com", fetchImpl: mock.fetchImpl });

    await provider.add("note", { tags: ["work"] });

    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body.content).toBe("note");
    expect(body.tags).toEqual(["work"]);
  });

  it("blocks private endpoints (SSRF guard)", () => {
    const provider = createOpenVikingProvider({ endpoint: "https://ov.example.com" });
    const validation = provider.validateConfig({ endpoint: "http://localhost:8080" });
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes("blocked"))).toBe(true);
  });

  it("validates config requires endpoint", () => {
    const provider = createOpenVikingProvider({});
    const validation = provider.validateConfig({});
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("endpoint is required");
  });
});

describe("Mem0 provider", () => {
  it("searches with X-API-Key header", async () => {
    const mock = makeMockFetch([
      { id: "m1", memory: "hello world", score: 0.9 },
    ]);
    const provider = createMem0Provider({
      apiKey: "mem0-key",
      userId: "u1",
      fetchImpl: mock.fetchImpl,
    });

    const result = await provider.search("hello");

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("https://api.mem0.ai/v1/memories/search");
    expect(mock.lastRequest?.headers["x-api-key"]).toBe("mem0-key");
    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body.query).toBe("hello");
    expect(body.user_id).toBe("u1");
    expect(result.entries[0]?.content).toBe("hello world");
  });

  it("adds a memory", async () => {
    const mock = makeMockFetch(mockAddResponse);
    const provider = createMem0Provider({ apiKey: "mem0-key", fetchImpl: mock.fetchImpl });

    await provider.add("note");

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("https://api.mem0.ai/v1/memories");
    expect((mock.lastRequest?.body as Record<string, unknown>).content).toBe("note");
  });

  it("deletes by id", async () => {
    const mock = makeMockFetch(mockDeleteResponse);
    const provider = createMem0Provider({ apiKey: "mem0-key", fetchImpl: mock.fetchImpl });

    await provider.delete("m1");

    expect(mock.lastRequest?.method).toBe("DELETE");
    expect(mock.lastRequest?.url).toBe("https://api.mem0.ai/v1/memories/m1");
  });

  it("validates config requires apiKey", () => {
    const provider = createMem0Provider({});
    expect(provider.validateConfig({}).valid).toBe(false);
  });
});

describe("Hindsight provider", () => {
  it("recalls with bank_id", async () => {
    const mock = makeMockFetch(mockSearchResponse);
    const provider = createHindsightProvider({
      apiKey: "hind-key",
      bankId: "bank-1",
      fetchImpl: mock.fetchImpl,
    });

    await provider.search("hello");

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("https://api.hindsight.io/api/recall");
    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body.query).toBe("hello");
    expect(body.bank_id).toBe("bank-1");
  });

  it("retains content", async () => {
    const mock = makeMockFetch(mockAddResponse);
    const provider = createHindsightProvider({ apiKey: "hind-key", fetchImpl: mock.fetchImpl });

    await provider.add("insight");

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("https://api.hindsight.io/api/retain");
    expect((mock.lastRequest?.body as Record<string, unknown>).content).toBe("insight");
  });

  it("validates config requires apiKey", () => {
    const provider = createHindsightProvider({});
    expect(provider.validateConfig({}).valid).toBe(false);
  });
});

describe("Holographic provider", () => {
  it("searches the local endpoint", async () => {
    const mock = makeMockFetch(mockSearchResponse);
    const provider = createHolographicProvider({ fetchImpl: mock.fetchImpl });

    await provider.search("hello");

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("http://localhost:9121/search");
  });

  it("stores a fact", async () => {
    const mock = makeMockFetch(mockAddResponse);
    const provider = createHolographicProvider({ fetchImpl: mock.fetchImpl });

    await provider.add("fact");

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("http://localhost:9121/facts");
  });

  it("always validates config", () => {
    const provider = createHolographicProvider({});
    expect(provider.validateConfig().valid).toBe(true);
  });
});

describe("RetainDB provider", () => {
  it("searches with context", async () => {
    const mock = makeMockFetch(mockSearchResponse);
    const provider = createRetainDBProvider({ apiKey: "ret-key", fetchImpl: mock.fetchImpl });

    await provider.search("hello", { context: "project-x" });

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("https://api.retaindb.io/v1/search");
    expect((mock.lastRequest?.body as Record<string, unknown>).context).toBe("project-x");
  });

  it("remembers content", async () => {
    const mock = makeMockFetch(mockAddResponse);
    const provider = createRetainDBProvider({ apiKey: "ret-key", fetchImpl: mock.fetchImpl });

    await provider.add("resource");

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("https://api.retaindb.io/v1/remember");
  });

  it("validates config requires apiKey", () => {
    const provider = createRetainDBProvider({});
    expect(provider.validateConfig({}).valid).toBe(false);
  });
});

describe("ByteRover provider", () => {
  it("queries with working directory", async () => {
    const calls: string[][] = [];
    const provider = createByteRoverProvider({
      workingDir: "/home/hermes/byterover",
      runCommand: async (args: string[]) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({ results: [{ id: "b1", content: "match", score: 0.8 }] }),
          stderr: "",
          exitCode: 0,
        };
      },
    });

    const result = await provider.search("hello", { top_k: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["-C", "/home/hermes/byterover", "query", "hello", "--top-k", "5"]);
    expect(result.entries[0]?.id).toBe("b1");
  });

  it("curates content", async () => {
    const calls: string[][] = [];
    const provider = createByteRoverProvider({
      workingDir: "/home/hermes/byterover",
      runCommand: async (args: string[]) => {
        calls.push(args);
        return { stdout: JSON.stringify({ id: "b2", status: "added" }), stderr: "", exitCode: 0 };
      },
    });

    const result = await provider.add("note", { tags: "work" });

    expect(calls[0]).toEqual(["-C", "/home/hermes/byterover", "curate", "--add", "note", "--tags", "work"]);
    expect(result.id).toBe("b2");
  });

  it("validates config requires workingDir", () => {
    const provider = createByteRoverProvider({});
    expect(provider.validateConfig({}).valid).toBe(false);
    expect(provider.validateConfig({}).errors).toContain("workingDir is required");
  });
});

describe("Supermemory provider", () => {
  it("searches with container tag", async () => {
    const mock = makeMockFetch(mockSearchResponse);
    const provider = createSupermemoryProvider({
      apiKey: "sm-key",
      containerTag: "tag-1",
      fetchImpl: mock.fetchImpl,
    });

    await provider.search("hello");

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("https://api.supermemory.io/v4/search");
    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body.container_tag).toBe("tag-1");
  });

  it("stores a conversation", async () => {
    const mock = makeMockFetch(mockAddResponse);
    const provider = createSupermemoryProvider({ apiKey: "sm-key", fetchImpl: mock.fetchImpl });

    await provider.add("message");

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.url).toBe("https://api.supermemory.io/v4/conversations");
  });

  it("validates config requires apiKey", () => {
    const provider = createSupermemoryProvider({});
    expect(provider.validateConfig({}).valid).toBe(false);
  });
});
