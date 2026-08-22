import { describe, expect, it } from "vitest";
import {
  buildSessionLink,
  compressionRoot,
  dedupByLineage,
  demoteSources,
  filterHiddenSources,
  parseSessionLink,
} from "./lineage";

describe("buildSessionLink", () => {
  it("emits canonical @session token", () => {
    expect(buildSessionLink("abc", "default")).toBe("@session:default/abc");
  });
});

describe("parseSessionLink", () => {
  it("parses profile and id", () => {
    expect(parseSessionLink("@session:default/abc")).toEqual({
      profile: "default",
      sessionId: "abc",
    });
  });

  it("falls back to default profile", () => {
    expect(parseSessionLink("@session:/abc")).toEqual({
      profile: "default",
      sessionId: "abc",
    });
  });

  it("returns null for invalid link", () => {
    expect(parseSessionLink("not-a-link")).toBeNull();
  });
});

describe("compressionRoot", () => {
  it("returns the same id when no parent", () => {
    const map = new Map([["a", { session_id: "a" }]]);
    expect(compressionRoot("a", map)).toBe("a");
  });

  it("walks parent chain", () => {
    const map = new Map([
      ["a", { session_id: "a", parent_session_id: "b" }],
      ["b", { session_id: "b", parent_session_id: "c" }],
      ["c", { session_id: "c" }],
    ]);
    expect(compressionRoot("a", map)).toBe("c");
  });

  it("breaks cycles", () => {
    const map = new Map([
      ["a", { session_id: "a", parent_session_id: "b" }],
      ["b", { session_id: "b", parent_session_id: "a" }],
    ]);
    expect(compressionRoot("a", map)).toBe("b");
  });
});

describe("dedupByLineage", () => {
  it("keeps first representative per compression root", () => {
    const map = new Map([
      ["a", { session_id: "a", parent_session_id: "root" }],
      ["b", { session_id: "b", parent_session_id: "root" }],
      ["root", { session_id: "root" }],
    ]);
    const rows = [{ session_id: "a" }, { session_id: "b" }, { session_id: "other" }];
    expect(dedupByLineage(rows, map)).toEqual([
      { session_id: "a" },
      { session_id: "other" },
    ]);
  });
});

describe("demoteSources", () => {
  it("moves cron sources to the end", () => {
    const rows = [{ source: "cron" }, { source: "chat" }, { source: "cron" }];
    expect(demoteSources(rows)).toEqual([
      { source: "chat" },
      { source: "cron" },
      { source: "cron" },
    ]);
  });
});

describe("filterHiddenSources", () => {
  it("removes hidden sources", () => {
    const rows = [{ source: "kanban" }, { source: "chat" }, { source: "tool" }];
    expect(filterHiddenSources(rows)).toEqual([{ source: "chat" }]);
  });
});
