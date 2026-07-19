import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@hermes/protocol";
import { deriveSidebarSessionLists } from "./sidebar-session-lists";

function session(id: string, startedAt: number, endedAt: number | null = startedAt + 10): SessionSummary {
  return {
    id,
    model: "model",
    title: id,
    started_at: startedAt,
    ended_at: endedAt,
    message_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
  };
}

describe("deriveSidebarSessionLists", () => {
  it("keeps pinned sessions before recent and excludes them from recent", () => {
    const lists = deriveSidebarSessionLists(
      [session("s1", 10), session("s2", 20), session("s3", 30)],
      ["s2"],
      () => false,
    );

    expect(lists.pinned.map((item) => item.id)).toEqual(["s2"]);
    expect(lists.recent.map((item) => item.id)).toEqual(["s3", "s1"]);
  });

  it("orders pinned sessions by persisted pin order", () => {
    const lists = deriveSidebarSessionLists(
      [session("s1", 30), session("s2", 20), session("s3", 10)],
      ["s3", "s1"],
      () => false,
    );

    expect(lists.pinned.map((item) => item.id)).toEqual(["s3", "s1"]);
  });

  it("limits recent sessions to eight by last activity time", () => {
    const lists = deriveSidebarSessionLists(
      [
        session("s1", 1),
        session("s2", 2),
        session("s3", 3),
        session("s4", 4),
        session("s5", 5),
        session("s6", 6),
        session("s7", 7),
        session("s8", 8),
        session("s9", 9),
      ],
      [],
      () => false,
    );

    expect(lists.recent.map((item) => item.id)).toEqual(["s9", "s8", "s7", "s6", "s5", "s4", "s3", "s2"]);
  });

  it("uses started time for active sessions and keeps running sessions out of recent", () => {
    const lists = deriveSidebarSessionLists(
      [session("done", 1, 3), session("running", 10, null)],
      [],
      (item) => item.id === "running",
    );

    expect(lists.active.map((item) => item.id)).toEqual(["running"]);
    expect(lists.recent.map((item) => item.id)).toEqual(["done"]);
  });
});
