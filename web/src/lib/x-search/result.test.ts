import { describe, expect, it } from "vitest";
import {
  buildXSearchResult,
  extractAnswer,
  extractCitations,
  extractInlineCitations,
} from "./result";
import type { XaiResponse } from "./responses-client";
import type { XSearchArgs } from "./types";

function response(output: XaiResponse["output"]): XaiResponse {
  return { output };
}

function textItem(text: string): NonNullable<NonNullable<XaiResponse["output"]>[number]["content"]>[number] {
  return { type: "output_text", text };
}

function citationItem(
  url: string,
  opts: { title?: string; type?: string; start_index?: number; end_index?: number } = {},
): NonNullable<NonNullable<XaiResponse["output"]>[number]["content"]>[number] {
  return {
    type: "output_text",
    annotations: [
      {
        type: opts.type ?? "url_citation",
        url_citation: { url, title: opts.title },
        start_index: opts.start_index,
        end_index: opts.end_index,
      },
    ],
  };
}

describe("extractAnswer", () => {
  it("joins text parts across output items", () => {
    const out = extractAnswer(
      response([
        { content: [textItem("first"), textItem("second")] },
        { content: [textItem("third")] },
      ]),
    );
    expect(out).toBe("first\nsecond\nthird");
  });

  it("ignores non-text content parts", () => {
    const out = extractAnswer(response([{ content: [{ type: "reasoning" }] }]));
    expect(out).toBe("");
  });

  it("trims leading/trailing whitespace and newlines", () => {
    expect(extractAnswer(response([{ content: [textItem("  hello\n")] }]))).toBe("hello");
  });

  it("returns an empty string for an empty response", () => {
    expect(extractAnswer(response([]))).toBe("");
    expect(extractAnswer({})).toBe("");
  });

  it("skips content parts without text", () => {
    const out = extractAnswer(response([{ content: [{ type: "output_text" }, textItem("x")] }]));
    expect(out).toBe("x");
  });
});

describe("extractCitations", () => {
  it("collects url citations with titles", () => {
    const out = extractCitations(
      response([{ content: [citationItem("https://a.example", { title: "A" }), citationItem("https://b.example")] }]),
    );
    expect(out).toEqual([{ url: "https://a.example", title: "A" }, { url: "https://b.example", title: undefined }]);
  });

  it("deduplicates the same url across items", () => {
    const out = extractCitations(
      response([
        { content: [citationItem("https://a.example", { title: "A" })] },
        { content: [citationItem("https://a.example", { title: "A again" })] },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("A");
  });

  it("skips annotations without a url_citation url", () => {
    const item = {
      type: "output_text",
      annotations: [{ type: "url_citation", url_citation: {} }],
    } as const;
    expect(extractCitations(response([{ content: [item as never] }]))).toEqual([]);
  });

  it("returns an empty array when there is no output", () => {
    expect(extractCitations({})).toEqual([]);
  });
});

describe("extractInlineCitations", () => {
  it("keeps only url_citation annotations with indices", () => {
    const out = extractInlineCitations(
      response([
        {
          content: [
            citationItem("https://a.example", { title: "A", start_index: 0, end_index: 10 }),
            citationItem("https://b.example", { type: "other", start_index: 4, end_index: 5 }),
          ],
        },
      ]),
    );
    expect(out).toEqual([
      { url: "https://a.example", title: "A", start_index: 0, end_index: 10 },
    ]);
  });

  it("deduplicates urls, keeping the first occurrence", () => {
    const out = extractInlineCitations(
      response([
        {
          content: [
            citationItem("https://a.example", { title: "first", start_index: 0, end_index: 1 }),
            citationItem("https://a.example", { title: "second", start_index: 5, end_index: 6 }),
          ],
        },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "first", start_index: 0, end_index: 1 });
  });
});

describe("buildXSearchResult", () => {
  const creds = { source: "xai" as const, baseUrl: "https://api.x.ai/v1" };
  const model = "grok-4.5";

  function args(overrides: Partial<XSearchArgs> = {}): XSearchArgs {
    return { query: "hermes agent", ...overrides };
  }

  it("assembles a full result with answer, citations and model metadata", () => {
    const res = buildXSearchResult(
      args(),
      response([
        {
          content: [
            textItem("Answer text"),
            citationItem("https://x.example/1", { title: "T1", start_index: 3, end_index: 9 }),
            citationItem("https://x.example/2", { title: "T2", type: "other" }),
          ],
        },
      ]),
      creds,
      model,
    );
    expect(res).toMatchObject({
      success: true,
      provider: "xai",
      credential_source: "xai",
      tool: "x_search",
      model,
      query: "hermes agent",
      answer: "Answer text",
      citations: [
        { url: "https://x.example/1", title: "T1" },
        { url: "https://x.example/2", title: "T2" },
      ],
      inline_citations: [
        { url: "https://x.example/1", title: "T1", start_index: 3, end_index: 9 },
      ],
      degraded: false,
      degraded_reason: null,
    });
  });

  it("is not degraded when filters are active but citations are present", () => {
    const res = buildXSearchResult(
      args({ from_date: "2025-01-01", to_date: "2025-02-01" }),
      response([{ content: [citationItem("https://x.example/1")] }]),
      creds,
      model,
    );
    expect(res.degraded).toBe(false);
    expect(res.degraded_reason).toBeNull();
  });

  it("flags degraded results when filters are active and no citations came back", () => {
    const filterCases: Array<Partial<XSearchArgs>> = [
      { allowed_x_handles: ["hermes"] },
      { excluded_x_handles: ["spam"] },
      { from_date: "2025-01-01" },
      { to_date: "2025-02-01" },
    ];
    for (const extra of filterCases) {
      const res = buildXSearchResult(args(extra), response([]), creds, model);
      expect(res.degraded).toBe(true);
      expect(res.degraded_reason).toBe(
        "Filters were applied but xAI returned no source citations.",
      );
    }
  });

  it("is not degraded without filters even when the answer is empty", () => {
    const res = buildXSearchResult(args(), response([{ content: [] }]), creds, model);
    expect(res.degraded).toBe(false);
    expect(res.degraded_reason).toBeNull();
    expect(res.answer).toBe("");
  });

  it("propagates the oauth credential source", () => {
    const res = buildXSearchResult(
      args(),
      response([]),
      { source: "xai-oauth", baseUrl: "https://api.x.ai/v1" },
      model,
    );
    expect(res.credential_source).toBe("xai-oauth");
  });
});
