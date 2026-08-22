import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registry, type ToolContext } from "@hermes/agent-tools";
import * as http from "@/lib/web-search/http.js";
import { setXaiCredentialsForTest } from "./credentials.js";
import { setXaiConfigForTest, resetXaiConfigCache } from "./tool.js";
import "./tool.js";

const ctx: ToolContext = { env: { XAI_API_KEY: "key" } };

function mockWebRequest(result: Partial<http.WebRequestResult>) {
  return vi.spyOn(http, "webRequest").mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: "",
    ...result,
  });
}

describe("x_search tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetXaiConfigCache();
    setXaiCredentialsForTest(null);
    setXaiConfigForTest({});
  });

  it("schema description does not mention xurl or web_search", () => {
    const entry = registry.get("x_search");
    expect(entry).toBeDefined();
    const desc = entry!.description ?? "";
    expect(desc.toLowerCase()).not.toContain("xurl");
    expect(desc.toLowerCase()).not.toContain("web_search");
  });

  it("returns answer and citations", async () => {
    setXaiCredentialsForTest({ bearer: "key", source: "xai", baseUrl: "https://api.x.ai/v1" });
    mockWebRequest({
      body: JSON.stringify({
        output: [
          {
            content: [
              {
                text: "The answer.",
                annotations: [
                  {
                    type: "url_citation",
                    start_index: 4,
                    end_index: 10,
                    url_citation: { url: "https://x.com/post", title: "Post" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    const result = await registry.dispatch("x_search", { query: "latest news" }, ctx);
    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.answer).toBe("The answer.");
    expect(parsed.citations).toHaveLength(1);
    expect(parsed.inline_citations[0].start_index).toBe(4);
  });

  it("marks degraded when filters active but no citations", async () => {
    setXaiCredentialsForTest({ bearer: "key", source: "xai", baseUrl: "https://api.x.ai/v1" });
    mockWebRequest({ body: JSON.stringify({ output: [{ content: [{ text: "No sources." }] }] }) });
    const result = await registry.dispatch("x_search", { query: "q", from_date: "2024-01-01" }, ctx);
    const parsed = JSON.parse(result.content);
    expect(parsed.degraded).toBe(true);
    expect(parsed.degraded_reason).toContain("no source citations");
  });

  it("rejects conflicting filters without HTTP call", async () => {
    setXaiCredentialsForTest({ bearer: "key", source: "xai", baseUrl: "https://api.x.ai/v1" });
    const spy = vi.spyOn(http, "webRequest");
    const result = await registry.dispatch(
      "x_search",
      { query: "q", allowed_x_handles: ["a"], excluded_x_handles: ["b"] },
      ctx,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.parse(result.content).error).toContain("mutually exclusive");
  });

  it("rejects invalid date without HTTP call", async () => {
    setXaiCredentialsForTest({ bearer: "key", source: "xai", baseUrl: "https://api.x.ai/v1" });
    const spy = vi.spyOn(http, "webRequest");
    const result = await registry.dispatch("x_search", { query: "q", from_date: "bad" }, ctx);
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.parse(result.content).error).toContain("YYYY-MM-DD");
  });
});