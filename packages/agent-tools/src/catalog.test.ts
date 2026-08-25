import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  objectSchema,
  registerBuiltinCatalog,
  isCatalogRegistered,
  builtinCatalogSize,
} from "./catalog.js";
import { registry, ToolRegistry } from "./registry.js";
import { capabilityStore } from "./gates.js";
import { z } from "zod";

describe("objectSchema (Zod → OpenAI JSON schema)", () => {
  it("builds an object schema with all keys required by default", () => {
    const schema = objectSchema({
      action: z.string(),
      count: z.number(),
    });
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(["action", "count"]);
    expect(schema.required).toEqual(["action", "count"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("honors an explicit required list", () => {
    const schema = objectSchema(
      { domain: z.string(), service: z.string(), entity_id: z.string().optional() },
      ["domain", "service"],
    );
    expect(schema.required).toEqual(["domain", "service"]);
  });

  it("converts optional, defaulted, enum and array zods", () => {
    const schema = objectSchema({
      opt: z.string().optional(),
      def: z.number().default(10),
      mode: z.enum(["a", "b"]),
      list: z.array(z.string()),
    }) as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties.opt).toEqual({ type: "string" });
    expect(schema.properties.def).toEqual({ type: "number" });
    expect(schema.properties.mode).toEqual({ type: "string", enum: ["a", "b"] });
    expect(schema.properties.list).toEqual({ type: "array", items: { type: "string" } });
  });

  it("preserves descriptions on string props and falls back for exotic zods", () => {
    const schema = objectSchema({
      s: z.string().describe("A description"),
      rec: z.record(z.unknown()),
    }) as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties.s).toEqual({ type: "string", description: "A description" });
    // Unknown / record zods fall back to a plain string schema.
    expect(schema.properties.rec).toEqual({ type: "string" });
  });
});

describe("built-in catalog registration", () => {
  beforeEach(() => {
    capabilityStore.invalidate();
  });

  it("registers a fixed number of built-in tools and reports size", () => {
    // Auto-registration happens on import; calling it again is idempotent (replace).
    registerBuiltinCatalog();
    expect(builtinCatalogSize()).toBe(75);
    expect(registry.names().length).toBeGreaterThanOrEqual(builtinCatalogSize());
    expect(isCatalogRegistered()).toBe(true);
  });

  it("exposes representative core tools with schemas and handlers", () => {
    for (const name of ["todo", "clarify", "complete", "think", "delegate_task"]) {
      const entry = registry.get(name);
      expect(entry, `expected ${name} to be registered`).toBeDefined();
      expect(entry!.schema).toBeDefined();
      expect(entry!.schema.type).toBe("object");
      expect(entry!.handler).toBeTypeOf("function");
      expect(entry!.toolset).toBe("core");
    }
  });

  it("maps tool names to toolsets", () => {
    const map = registry.getToolToToolsetMap();
    expect(map.get("todo")).toBe("core");
    expect(map.get("file_read")).toBe("file");
    expect(map.get("browser_navigate")).toBe("browser");
    expect(map.get("x_search")).toBe("x_search");
  });
});

describe("catalog handlers", () => {
  it("todo handler formats action/content", async () => {
    const res = await registry.dispatch("todo", { action: "add", content: "milk" }, {});
    expect(res.content).toContain("todo add: milk");
  });

  it("clarify handler returns the question", async () => {
    const res = await registry.dispatch("clarify", { question: "which?" }, {});
    expect(res.content).toBe("Clarification requested: which?");
  });

  it("batch_run defaults concurrency to 4 and counts items", async () => {
    const res = await registry.dispatch("batch_run", { items: ["a", "b"] }, {});
    expect(res.content).toContain("2 items");
    expect(res.content).toContain("concurrency 4");
  });

  it("event_hook_trigger stringifies the payload", async () => {
    const res = await registry.dispatch("event_hook_trigger", { event: "turn_complete", payload: { ok: true } }, {});
    expect(res.content).toContain("turn_complete");
    expect(res.content).toContain('"ok":true');
  });

  it("file_read native fallback is marked as an error", async () => {
    const res = await registry.dispatch("file_read", { path: "/tmp/x" }, { sessionId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("/tmp/x");
    expect(res.content).toContain("s1");
  });

  it("terminal_run is a stub marked as an error", async () => {
    const res = await registry.dispatch("terminal_run", { command: "ls", timeout: 5 }, {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("timeout 5s");
  });

  it("web_search routes through ctx.invoke when a Rust invoker is present", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const res = await registry.dispatch(
      "web_search",
      { query: "hermes agent", limit: 3 },
      { sessionId: "s1", invoke },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe("web_provider_request");
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain('"ok":true');
  });

  it("web_search parses DuckDuckGo lite results without an invoker", async () => {
    const html =
      '<a class="result__a" href="https://example.com/a">First <b>Result</b></a>' +
      '<a class="result__a" href="https://example.com/b">Second Result</a>';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
    try {
      const res = await registry.dispatch("web_search", { query: "hermes", limit: 2 }, {});
      expect(res.isError).not.toBe(true);
      expect(res.content).toContain("First Result");
      expect(res.content).toContain("https://example.com/b");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("memory_write fallback stores in-memory and memory_read retrieves it", async () => {
    const write = await registry.dispatch("memory_write", { key: "k1", value: "v1" }, {});
    expect(write.isError).not.toBe(true);
    expect(write.content).toContain("stored");
    const read = await registry.dispatch("memory_read", { key: "k1" }, {});
    expect(read.isError).not.toBe(true);
    expect(read.content).toBe("v1");
    const missing = await registry.dispatch("memory_read", { key: "nope" }, {});
    expect(missing.isError).toBe(true);
  });

  it("image_generate without a provider returns an actionable error", async () => {
    const res = await registry.dispatch("image_generate", { prompt: "cat" }, { env: {} });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("OPENAI_API_KEY");
  });

  it("returns an error result for unknown tools", async () => {
    const res = await registry.dispatch("does_not_exist", {}, {});
    expect(res.isError).toBe(true);
  });
});

describe("capability gating of catalog tools", () => {
  beforeEach(() => {
    capabilityStore.invalidate();
  });

  it("x_search is gated by env credentials", async () => {
    const without = await registry.getDefinitions(["x_search"], { env: {} });
    expect(without).toHaveLength(0);
    // Capability probes are cached by tool name; invalidate before re-probing.
    capabilityStore.invalidate("x_search");
    const withCreds = await registry.getDefinitions(["x_search"], { env: { XAI_API_KEY: "k" } });
    expect(withCreds).toHaveLength(1);
    expect(withCreds[0].function.name).toBe("x_search");
  });

  it("spotify tools are gated on client id AND secret", async () => {
    const without = await registry.getDefinitions(["spotify_play"], { env: { SPOTIFY_CLIENT_ID: "id" } });
    expect(without).toHaveLength(0);
    capabilityStore.invalidate("spotify_play");
    const withCreds = await registry.getDefinitions(["spotify_play"], {
      env: { SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "sec" },
    });
    expect(withCreds).toHaveLength(1);
  });

  it("browser tools are always available (local backend fallback)", async () => {
    const defs = await registry.getDefinitions(["browser_navigate"], { env: {} });
    expect(defs).toHaveLength(1);
  });

  it("homeassistant gate accepts either HOME_ASSISTANT_TOKEN or HASS_TOKEN", async () => {
    const viaPrimary = await registry.getDefinitions(["ha_get_state"], { env: { HOME_ASSISTANT_TOKEN: "t" } });
    expect(viaPrimary).toHaveLength(1);
    capabilityStore.invalidate();
    const viaAlt = await registry.getDefinitions(["ha_get_state"], { env: { HASS_TOKEN: "t" } });
    expect(viaAlt).toHaveLength(1);
  });
});

describe("registry independence", () => {
  it("a fresh ToolRegistry is not affected by the global catalog", () => {
    const fresh = new ToolRegistry();
    expect(fresh.has("todo")).toBe(false);
    fresh.register({
      name: "mine",
      toolset: "test",
      schema: objectSchema({ x: z.string() }),
      handler: async () => ({ content: "ok" }),
    });
    expect(fresh.has("mine")).toBe(true);
    expect(registry.has("mine")).toBe(false);
  });
});
