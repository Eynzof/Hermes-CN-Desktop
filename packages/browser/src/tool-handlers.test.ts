import { describe, expect, it, vi } from "vitest";
import {
  browserBack,
  browserCdp,
  browserClick,
  browserConsole,
  browserDialog,
  browserExec,
  browserGetImages,
  browserNavigate,
  browserPress,
  browserScroll,
  browserSnapshot,
  browserToolSchemas,
  browserType,
  browserVision,
  objectSchema,
  zodToJsonSchema,
  type BrowserInvoker,
  type BrowserToolContext,
  type ToolResult,
} from "./tool-handlers.js";
import { z } from "zod";

/** Build an invoker that records calls and returns canned results per command. */
function makeInvoker(results?: Record<string, unknown>) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invoke: BrowserInvoker = vi.fn(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (results && command in results) return results[command];
    return { success: true };
  });
  return { invoke, calls };
}

let sessionCounter = 0;
function ctx(overrides: Partial<BrowserToolContext> = {}): BrowserToolContext {
  sessionCounter += 1;
  return { sessionId: `task-${sessionCounter}`, ...overrides };
}

describe("browserNavigate", () => {
  it("parses args, creates a local session and forwards the navigation", async () => {
    const { invoke, calls } = makeInvoker({
      browser_navigate: { success: true, url: "https://example.com/", title: "Example" },
    });
    const result = await browserNavigate(
      { url: "https://example.com", timeout: 30 },
      ctx({ invoke }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("https://example.com/");
    expect(calls).toContainEqual({
      command: "browser_sidecar_start",
      args: {
        taskId: expect.any(String),
        engine: "chromium",
        headed: false,
        recordSessions: false,
      },
    });
    expect(calls).toContainEqual({
      command: "browser_navigate",
      args: { taskId: expect.any(String), url: "https://example.com/", timeout: 30 },
    });
  });

  it("uses ctx.sessionId as the session key and reuses the session", async () => {
    const { invoke, calls } = makeInvoker();
    const toolCtx = ctx({ sessionId: "reuse-1", invoke });
    await browserNavigate({ url: "https://example.com" }, toolCtx);
    await browserNavigate({ url: "https://other.example.com" }, toolCtx);
    const starts = calls.filter((c) => c.command === "browser_sidecar_start");
    const navigates = calls.filter((c) => c.command === "browser_navigate");
    expect(starts).toHaveLength(1);
    expect(navigates).toHaveLength(2);
    expect(starts[0].args.taskId).toBe("reuse-1");
  });

  it("defaults the session id to 'default'", async () => {
    const { invoke, calls } = makeInvoker();
    await browserNavigate({ url: "https://example.com" }, { invoke });
    expect(calls.find((c) => c.command === "browser_sidecar_start")?.args.taskId).toBe("default");
  });

  it("returns the snapshot as the content when present", async () => {
    const { invoke } = makeInvoker({
      browser_navigate: { success: true, snapshot: "<html><body>hi</body></html>", url: "https://example.com/" },
    });
    const result = await browserNavigate({ url: "https://example.com" }, ctx({ invoke }));
    expect(result.content).toBe("<html><body>hi</body></html>");
    expect(result.isError).toBeUndefined();
  });

  it("turns operation errors into error tool results", async () => {
    const { invoke } = makeInvoker({ browser_navigate: { success: false, error: "net::ERR_REFUSED" } });
    const result = await browserNavigate({ url: "https://example.com" }, ctx({ invoke }));
    expect(result).toEqual({ content: "net::ERR_REFUSED", isError: true });
  });

  it("returns an error when the backend does not implement navigate", async () => {
    const result = await browserNavigate(
      { url: "https://example.com" },
      ctx({ env: { BROWSERBASE_API_KEY: "bb-key" } }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("browserbase navigate not yet implemented");
  });

  it("throws a zod error for invalid input", async () => {
    const { invoke } = makeInvoker();
    await expect(browserNavigate({ timeout: 5 }, ctx({ invoke }))).rejects.toThrow();
    await expect(browserNavigate({ url: 42 }, ctx({ invoke }))).rejects.toThrow();
  });
});

describe("browserSnapshot", () => {
  it("forwards the full flag and returns snapshot content", async () => {
    const { invoke, calls } = makeInvoker({
      browser_snapshot: { success: true, snapshot: "<a11y tree>" },
    });
    const result = await browserSnapshot({ full: true, maxChars: 5000 }, ctx({ invoke }));
    expect(result.content).toBe("<a11y tree>");
    expect(calls).toContainEqual({
      command: "browser_snapshot",
      args: { taskId: expect.any(String), full: true },
    });
  });

  it("reports unsupported cloud backends (browserbase is in the legacy walk)", async () => {
    const result = await browserSnapshot(
      { full: false },
      ctx({ env: { BROWSERBASE_API_KEY: "bb-key" } }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("browserbase snapshot not yet implemented");
  });
});

describe("browserClick / browserType / browserScroll / browserBack / browserPress / browserConsole", () => {
  it("click forwards the element ref", async () => {
    const { invoke, calls } = makeInvoker({ browser_click: { success: true } });
    const result = await browserClick({ ref: "@e1" }, ctx({ invoke }));
    expect(result.isError).toBeUndefined();
    // The success flag is stripped from the tool result payload.
    expect(result.content).toBe("{}");
    expect(calls).toContainEqual({ command: "browser_click", args: { taskId: expect.any(String), ref: "@e1" } });
  });

  it("type forwards ref, text and submit", async () => {
    const { invoke, calls } = makeInvoker({ browser_type: { success: true } });
    await browserType({ ref: "@e2", text: "hello", submit: true }, ctx({ invoke }));
    expect(calls).toContainEqual({
      command: "browser_type",
      args: { taskId: expect.any(String), ref: "@e2", text: "hello", submit: true },
    });
  });

  it("scroll forwards direction and amount", async () => {
    const { invoke, calls } = makeInvoker({ browser_scroll: { success: true } });
    await browserScroll({ direction: "down", amount: 250 }, ctx({ invoke }));
    expect(calls).toContainEqual({
      command: "browser_scroll",
      args: { taskId: expect.any(String), direction: "down", amount: 250 },
    });
  });

  it("back forwards to the sidecar", async () => {
    const { invoke, calls } = makeInvoker({ browser_back: { success: true } });
    const result = await browserBack({}, ctx({ invoke }));
    expect(result.isError).toBeUndefined();
    expect(calls).toContainEqual({ command: "browser_back", args: { taskId: expect.any(String) } });
  });

  it("press forwards the key", async () => {
    const { invoke, calls } = makeInvoker({ browser_press: { success: true } });
    await browserPress({ key: "Enter" }, ctx({ invoke }));
    expect(calls).toContainEqual({ command: "browser_press", args: { taskId: expect.any(String), key: "Enter" } });
  });

  it("console forwards expression and clear", async () => {
    const { invoke, calls } = makeInvoker({
      browser_console: { success: true, console: [{ type: "log", text: "hi" }] },
    });
    const result = await browserConsole({ expression: "1+1", clear: true }, ctx({ invoke }));
    expect(result.content).toContain("hi");
    expect(calls).toContainEqual({
      command: "browser_console",
      args: { taskId: expect.any(String), expression: "1+1", clear: true },
    });
  });

  it("rejects invalid directions and refs", async () => {
    const { invoke } = makeInvoker();
    await expect(browserScroll({ direction: "diagonal" }, ctx({ invoke }))).rejects.toThrow();
    await expect(browserClick({ ref: 42 }, ctx({ invoke }))).rejects.toThrow();
  });
});

describe("not-yet-implemented placeholders", () => {
  it("returns explicit not-implemented content for gated tools", async () => {
    const results: Array<[Promise<ToolResult>, string]> = [
      [browserGetImages(), "browser_get_images not yet implemented in local backend"],
      [browserVision(), "browser_vision not yet implemented in local backend"],
      [browserCdp(), "browser_cdp not yet implemented in local backend"],
      [browserDialog(), "browser_dialog not yet implemented in local backend"],
      [browserExec(), "browser_exec not yet implemented in local backend"],
    ];
    for (const [promise, expected] of results) {
      await expect(promise).resolves.toEqual({ content: expected });
    }
  });
});

describe("browserToolSchemas", () => {
  it("maps every tool key to a parseable zod schema", () => {
    const keys = Object.keys(browserToolSchemas);
    expect(keys.sort()).toEqual(
      ["cdp", "click", "console", "dialog", "exec", "navigate", "press", "scroll", "snapshot", "type"].sort(),
    );
  });

  it("navigate schema requires url", () => {
    expect(browserToolSchemas.navigate.safeParse({ url: "https://x", timeout: 5 }).success).toBe(true);
    expect(browserToolSchemas.navigate.safeParse({ timeout: 5 }).success).toBe(false);
  });

  it("scroll schema restricts directions", () => {
    expect(browserToolSchemas.scroll.safeParse({ direction: "up" }).success).toBe(true);
    expect(browserToolSchemas.scroll.safeParse({ direction: "sideways" }).success).toBe(false);
  });

  it("dialog schema restricts actions", () => {
    expect(browserToolSchemas.dialog.safeParse({ action: "respond", promptText: "y" }).success).toBe(true);
    expect(browserToolSchemas.dialog.safeParse({ action: "maybe" }).success).toBe(false);
  });

  it("exec schema requires code", () => {
    expect(browserToolSchemas.exec.safeParse({ code: "print(1)" }).success).toBe(true);
    expect(browserToolSchemas.exec.safeParse({}).success).toBe(false);
  });
});

describe("zodToJsonSchema", () => {
  it("maps strings with descriptions", () => {
    expect(zodToJsonSchema(z.string().describe("The URL"))).toEqual({
      type: "string",
      description: "The URL",
    });
  });

  it("maps numbers, booleans and arrays", () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: "number" });
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" });
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({ type: "array", items: { type: "string" } });
  });

  it("maps objects with required tracking", () => {
    const schema = z.object({
      url: z.string(),
      timeout: z.number().optional(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: { url: { type: "string" }, timeout: { type: "number" } },
      required: ["url"],
      additionalProperties: false,
    });
  });

  it("maps optional, enum and default wrappers", () => {
    expect(zodToJsonSchema(z.string().optional())).toEqual({ type: "string" });
    expect(zodToJsonSchema(z.enum(["a", "b"]))).toEqual({ type: "string", enum: ["a", "b"] });
    expect(zodToJsonSchema(z.string().default("x"))).toEqual({ type: "string" });
  });

  it("falls back to a generic string schema for unknown types", () => {
    expect(zodToJsonSchema(z.any())).toEqual({ type: "string" });
    expect(zodToJsonSchema(z.null())).toEqual({ type: "string" });
  });
});

describe("objectSchema", () => {
  it("builds an object schema with all keys required by default", () => {
    const schema = objectSchema({ url: z.string(), n: z.number() });
    expect(schema).toEqual({
      type: "object",
      properties: { url: { type: "string" }, n: { type: "number" } },
      required: ["url", "n"],
      additionalProperties: false,
    });
  });

  it("honors an explicit required list", () => {
    const schema = objectSchema({ a: z.string(), b: z.string() }, ["a"]);
    expect(schema.required).toEqual(["a"]);
  });
});
