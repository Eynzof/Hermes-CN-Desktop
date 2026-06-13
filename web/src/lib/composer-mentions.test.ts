import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@hermes/protocol";
import {
  buildCompletePathWord,
  buildMentionReplacement,
  classifyMention,
  filterSessionMentions,
  getActiveMentionToken,
  getMentionCandidates,
  MENTION_STARTERS,
} from "./composer-mentions";

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "abc12345",
    title: null,
    started_at: 0,
    ended_at: null,
    message_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
    ...overrides,
  } as SessionSummary;
}

describe("getActiveMentionToken", () => {
  it("detects an @ token at the caret", () => {
    expect(getActiveMentionToken("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(getActiveMentionToken("看下 @file:main", 13)).toMatchObject({
      start: 3,
      query: "file:main",
    });
  });

  it("requires the @ to follow start-of-input or whitespace", () => {
    expect(getActiveMentionToken("user@host", 9)).toBeNull();
  });

  it("spans the whole word for replacement even when the caret is mid-word", () => {
    // caret after "fi" but the word continues "le"
    const token = getActiveMentionToken("@file done", 3);
    expect(token).toMatchObject({ start: 0, end: 5, query: "fi" });
  });

  it("stops the query at a slash (basename-style completion)", () => {
    expect(getActiveMentionToken("@file:src/main", 14)).toBeNull();
  });
});

describe("classifyMention", () => {
  it("derives the kind and keepOpen flag from the text", () => {
    expect(classifyMention({ text: "@file:src/main.tsx", display: "main.tsx", meta: "src" })).toEqual({
      insertText: "@file:src/main.tsx",
      display: "main.tsx",
      meta: "src",
      kind: "file",
      keepOpen: false,
    });
    expect(classifyMention({ text: "@folder:" })).toMatchObject({ kind: "folder", keepOpen: true });
    expect(classifyMention({ text: "@diff" })).toMatchObject({ kind: "simple", keepOpen: false });
  });
});

describe("buildCompletePathWord", () => {
  it("appends a colon for starter prefixes, otherwise echoes the query", () => {
    expect(buildCompletePathWord("file")).toBe("@file:");
    expect(buildCompletePathWord("file:src")).toBe("@file:src");
    expect(buildCompletePathWord("diff")).toBe("@diff");
  });
});

describe("filterSessionMentions", () => {
  const sessions = [
    session({ id: "aaa11111", title: "鉴权重构", preview: "讨论登录流程" }),
    session({ id: "bbb22222", title: "部署脚本" }),
  ];

  it("builds @session tokens and filters by title/preview/id", () => {
    expect(filterSessionMentions(sessions, "session:登录", "default")).toEqual([
      {
        insertText: "@session:default/aaa11111",
        display: "鉴权重构",
        meta: "讨论登录流程",
        kind: "session",
        keepOpen: false,
      },
    ]);
    expect(filterSessionMentions(sessions, "session:", "p1").map((c) => c.insertText)).toEqual([
      "@session:p1/aaa11111",
      "@session:p1/bbb22222",
    ]);
  });
});

describe("buildMentionReplacement", () => {
  it("keeps the popover anchor for starters (no trailing space)", () => {
    const token = getActiveMentionToken("@fi", 3)!;
    const result = buildMentionReplacement("@fi", token, MENTION_STARTERS[0]!);
    expect(result.text).toBe("@file:");
    expect(result.cursor).toBe("@file:".length);
  });

  it("adds a trailing space for a final reference and avoids doubling it", () => {
    const token = getActiveMentionToken("@file:ma rest", 8)!;
    const candidate = classifyMention({ text: "@file:main.tsx" });
    const result = buildMentionReplacement("@file:ma rest", token, candidate);
    expect(result.text).toBe("@file:main.tsx rest");
  });
});

describe("getMentionCandidates", () => {
  it("returns starters for a bare @", async () => {
    const completePath = vi.fn();
    expect(await getMentionCandidates("", { completePath })).toEqual([...MENTION_STARTERS]);
    expect(completePath).not.toHaveBeenCalled();
  });

  it("routes @session: queries to local session filtering", async () => {
    const completePath = vi.fn();
    const sessions = [session({ id: "zzz99999", title: "会话甲" })];
    const out = await getMentionCandidates("session:甲", { completePath, sessions });
    expect(out.map((c) => c.insertText)).toEqual(["@session:default/zzz99999"]);
    expect(completePath).not.toHaveBeenCalled();
  });

  it("routes other queries to the backend and classifies the items", async () => {
    const completePath = vi.fn().mockResolvedValue({
      items: [{ text: "@file:src/app.tsx", display: "app.tsx", meta: "src" }],
    });
    const out = await getMentionCandidates("file:app", { completePath });
    expect(completePath).toHaveBeenCalledWith("@file:app");
    expect(out).toEqual([
      {
        insertText: "@file:src/app.tsx",
        display: "app.tsx",
        meta: "src",
        kind: "file",
        keepOpen: false,
      },
    ]);
  });

  it("falls back to starters when the backend errors", async () => {
    const completePath = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await getMentionCandidates("file:x", { completePath })).toEqual([...MENTION_STARTERS]);
  });
});
