import { describe, it, expect, vi, beforeEach } from "vitest";
import { registry, type ToolContext } from "@hermes/agent-tools";
import * as http from "./http.js";
import { setWebConfigForTest, setWebEnvForTest, resetWebConfigCache } from "./config.js";
import "./tools.js";

vi.mock("./http.js", () => {
  const webRequest = vi.fn();
  const webRequestJSON = vi.fn(async (input: http.WebRequestInput) => {
    const res = await webRequest(input);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 500)}`);
    }
    return JSON.parse(res.body);
  });
  const webRequestText = vi.fn(async (input: http.WebRequestInput) => {
    const res = await webRequest(input);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 500)}`);
    }
    return res.body;
  });
  return { webRequest, webRequestJSON, webRequestText };
});

const baseCtx: ToolContext = { env: {} };

function mockWebRequest(result: Partial<http.WebRequestResult>) {
  return vi.mocked(http.webRequest).mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: "",
    ...result,
  });
}

describe("web_search / web_extract tool handlers", () => {
  beforeEach(() => {
    vi.mocked(http.webRequest).mockReset();
    resetWebConfigCache();
    setWebConfigForTest({});
    setWebEnvForTest(null);
  });

  it("web_search returns JSON with success=true", async () => {
    setWebEnvForTest({ TAVILY_API_KEY: "k" });
    mockWebRequest({
      body: JSON.stringify({ results: [{ title: "T", url: "https://x.com", content: "C" }] }),
    });
    const result = await registry.dispatch("web_search", { query: "hello", limit: 3 }, baseCtx);
    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.data.web[0].url).toBe("https://x.com");
  });

  it("web_search clamps limit", async () => {
    setWebEnvForTest({ TAVILY_API_KEY: "k" });
    const spy = mockWebRequest({ body: JSON.stringify({ results: [] }) });
    await registry.dispatch("web_search", { query: "hi", limit: 999 }, baseCtx);
    const body = JSON.parse((spy.mock.calls[0][0].body as string) ?? "{}");
    expect(body.max_results).toBe(100);
  });

  it("web_extract handles URL dicts/hrefs", async () => {
    setWebEnvForTest({ FIRECRAWL_API_KEY: "k" });
    setWebConfigForTest({ extract_backend: "firecrawl" });
    mockWebRequest({
      body: JSON.stringify({ data: { title: "T", markdown: "body" } }),
    });
    const result = await registry.dispatch(
      "web_extract",
      { urls: [{ url: "https://example.com" }, { href: "https://example.org" }] },
      baseCtx,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.results).toHaveLength(2);
  });

  it("web_extract rejects invalid URLs", async () => {
    setWebEnvForTest({ FIRECRAWL_API_KEY: "k" });
    setWebConfigForTest({ extract_backend: "firecrawl" });
    mockWebRequest({ body: JSON.stringify({ data: { title: "T", markdown: "body" } }) });
    const result = await registry.dispatch("web_extract", { urls: ["not-a-url"] }, baseCtx);
    const parsed = JSON.parse(result.content);
    expect(parsed.results[0].error).toBeDefined();
  });
});
