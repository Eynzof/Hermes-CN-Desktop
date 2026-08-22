import { describe, it, expect, vi, beforeEach } from "vitest";
import * as http from "./http.js";
import {
  firecrawlProvider,
  searxngProvider,
  braveFreeProvider,
  ddgProvider,
  tavilyProvider,
  exaProvider,
  parallelProvider,
  xaiWebProvider,
} from "./providers/index.js";

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

describe("web-search providers", () => {
  beforeEach(() => {
    vi.mocked(http.webRequest).mockReset();
  });

  it("Firecrawl normalizes search results", async () => {
    mockWebRequest({
      body: JSON.stringify({
        data: {
          results: [
            { title: "T", url: "https://a.com", description: "D" },
            { title: "", url: "", description: "" }, // should be filtered
          ],
        },
      }),
    });
    const res = await firecrawlProvider.search("q", 5, {}, { FIRECRAWL_API_KEY: "k" });
    expect(res.success).toBe(true);
    expect(res.data?.web).toHaveLength(1);
    expect(res.data?.web[0]).toEqual({ title: "T", url: "https://a.com", description: "D", position: 1 });
  });

  it("SearXNG sorts by score", async () => {
    mockWebRequest({
      body: JSON.stringify({
        results: [
          { title: "A", url: "https://a.com", content: "a", score: 0.1 },
          { title: "B", url: "https://b.com", content: "b", score: 0.9 },
        ],
      }),
    });
    const res = await searxngProvider.search("q", 5, {}, { SEARXNG_URL: "http://localhost:8080" });
    expect(res.success).toBe(true);
    expect(res.data?.web[0].url).toBe("https://b.com");
  });

  it("Brave caps count at 20", async () => {
    const spy = mockWebRequest({
      body: JSON.stringify({ web: { results: [] } }),
    });
    await braveFreeProvider.search("q", 100, {}, { BRAVE_SEARCH_API_KEY: "k" });
    const url = spy.mock.calls[0][0].url;
    expect(url).toContain("count=20");
  });

  it("Tavily extract maps failed_results", async () => {
    mockWebRequest({
      body: JSON.stringify({
        results: [{ url: "https://ok.com", title: "OK", raw_content: "body" }],
        failed_results: [{ url: "https://bad.com", error: "timeout" }],
      }),
    });
    const res = await tavilyProvider.extract!(["https://ok.com", "https://bad.com"], {}, { TAVILY_API_KEY: "k" });
    expect(res[0].content).toBe("body");
    expect(res[1].error).toBe("timeout");
  });

  it("Exa requires API key", async () => {
    const res = await exaProvider.search("q", 3, {}, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain("EXA_API_KEY");
  });

  it("DDG parses HTML results", async () => {
    const html = `
      <div class="result results_links_deep">
        <a class="result__a" href="https://example.com/page">Example</a>
        <a class="result__snippet">snippet text</a>
      </div>
    `;
    mockWebRequest({ body: html });
    const res = await ddgProvider.search("q", 3, {}, {});
    expect(res.success).toBe(true);
    expect(res.data?.web[0]).toEqual({
      title: "Example",
      url: "https://example.com/page",
      description: "snippet text",
      position: 1,
    });
  });

  it("Parallel returns error without key", async () => {
    const res = await parallelProvider.search("q", 3, {}, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain("PARALLEL_API_KEY");
  });

  it("xAI parses response output annotations as citations", async () => {
    mockWebRequest({
      body: JSON.stringify({
        output: [
          {
            content: [
              {
                text: "answer text",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: { url: "https://x.com/post", title: "Post" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    const res = await xaiWebProvider.search("q", 5, {}, { XAI_API_KEY: "k" });
    expect(res.success).toBe(true);
    expect(res.data?.web[0].url).toBe("https://x.com/post");
  });
});
