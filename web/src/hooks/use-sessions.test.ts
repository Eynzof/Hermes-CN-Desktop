import { describe, expect, it, vi } from "vitest";
import type { SearchResult, SessionsResponse, SessionSummary } from "@hermes/protocol";
import {
  deleteSessionsInBatches,
  withoutSearchResults,
  withoutSessions,
} from "./use-sessions";

function session(id: string): SessionSummary {
  return {
    id,
    model: "model",
    title: id,
    started_at: 1,
    ended_at: 2,
    message_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
  };
}

function sessionsResponse(ids: string[]): SessionsResponse {
  return {
    sessions: ids.map(session),
    total: ids.length,
    limit: 50,
    offset: 0,
  };
}

function searchResult(id: string): SearchResult {
  return {
    session_id: id,
    snippet: id,
  };
}

describe("session cache delete helpers", () => {
  it("removes several sessions and updates total", () => {
    const result = withoutSessions(sessionsResponse(["s1", "s2", "s3"]), ["s1", "s3"]);

    expect(result?.sessions.map((item) => item.id)).toEqual(["s2"]);
    expect(result?.total).toBe(1);
  });

  it("removes matching search results", () => {
    const result = withoutSearchResults(
      { results: ["s1", "s2", "s3"].map(searchResult) },
      ["s2", "missing"],
    );

    expect(result?.results.map((item) => item.session_id)).toEqual(["s1", "s3"]);
  });
});

describe("deleteSessionsInBatches", () => {
  it("deduplicates ids and reports successful deletes", async () => {
    const deleteOne = vi.fn().mockResolvedValue(undefined);

    const result = await deleteSessionsInBatches(["s1", "s2", "s1", " "], deleteOne, 2);

    expect(deleteOne).toHaveBeenCalledTimes(2);
    expect(result.requestedIds).toEqual(["s1", "s2"]);
    expect(result.succeededIds).toEqual(["s1", "s2"]);
    expect(result.failed).toEqual([]);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
  });

  it("keeps partial failures visible to callers", async () => {
    const deleteOne = vi.fn(async (id: string) => {
      if (id === "s2") throw new Error("boom");
    });

    const result = await deleteSessionsInBatches(["s1", "s2", "s3"], deleteOne, 3);

    expect(result.succeededIds).toEqual(["s1", "s3"]);
    expect(result.failed).toEqual([{ id: "s2", error: "boom" }]);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
  });
});
