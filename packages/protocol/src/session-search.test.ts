import { describe, expect, it } from "vitest";
import {
  SessionSearchResult,
  SessionSearchResponse,
  SessionSearchRequest,
  SessionSearchToolRequest,
  SessionSearchToolResponse,
  StateDbFtsSearchRequest,
  StateDbSearchMeta,
} from "./session-search";

describe("session-search schemas", () => {
  it("SessionSearchResponse validates a minimal result", () => {
    const parsed = SessionSearchResponse.parse({ results: [{ session_id: "s1" }] });
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].session_id).toBe("s1");
  });

  it("SessionSearchResult tolerates null SQL columns", () => {
    const parsed = SessionSearchResult.parse({
      session_id: "s1",
      snippet: null,
      role: null,
      source: null,
      model: null,
      session_started: null,
    });
    expect(parsed.snippet).toBeUndefined();
    expect(parsed.session_started).toBeUndefined();
  });

  it("SessionSearchRequest fills defaults", () => {
    const parsed = SessionSearchRequest.parse({ query: "hello" });
    expect(parsed.query).toBe("hello");
    expect(parsed.limit).toBe(20);
    expect(parsed.include_inactive).toBe(false);
  });

  it("SessionSearchRequest clamps limit", () => {
    expect(SessionSearchRequest.parse({ limit: 200 }).limit).toBe(100);
    expect(SessionSearchRequest.parse({ limit: 0 }).limit).toBe(1);
  });

  it("StateDbFtsSearchRequest accepts mixed params", () => {
    const parsed = StateDbFtsSearchRequest.parse({
      sql: "SELECT * FROM messages WHERE id = ?",
      params: ["s1", 42, null],
    });
    expect(parsed.params).toEqual(["s1", 42, null]);
  });

  it("StateDbSearchMeta validates meta shape", () => {
    const parsed = StateDbSearchMeta.parse({
      schema_version: 25,
      fts_storage_version: 1,
      row_count_messages: 5,
      row_count_sessions: 2,
    });
    expect(parsed.schema_version).toBe(25);
  });

  it("SessionSearchToolRequest infers DISCOVER mode from query", () => {
    const parsed = SessionSearchToolRequest.parse({ query: "hello" });
    expect(parsed.query).toBe("hello");
    expect(parsed.limit).toBe(10);
    expect(parsed.window).toBe(5);
  });

  it("SessionSearchToolResponse validates browse shape", () => {
    const parsed = SessionSearchToolResponse.parse({
      mode: "browse",
      results: [{ session_id: "s1", link: "@session:default/s1" }],
    });
    expect(parsed.mode).toBe("browse");
  });
});
