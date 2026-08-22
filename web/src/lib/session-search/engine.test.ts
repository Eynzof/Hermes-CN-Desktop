import { describe, expect, it } from "vitest";
import type { SearchRow, SessionSearchBackend } from "./types";
import { SessionSearchEngine } from "./engine";

function fakeBackend(rows: SearchRow[] = []): SessionSearchBackend {
  return {
    async ftsSearch({ sql }) {
      // Echo SQL shape for tests that only need schema validation.
      if (/FROM sessions/.test(sql) && !/JOIN/.test(sql)) {
        return [
          {
            session_id: "s1",
            source: "chat",
            model: "gpt-4",
            session_started: 1234567890,
          },
        ] as SearchRow[];
      }
      return rows;
    },
    async query({ sql, params }) {
      if (/parent_session_id/.test(sql)) {
        return [
          { session_id: "s1", parent_session_id: null, end_reason: null, source: "chat" },
        ];
      }
      if (/timestamp FROM messages/.test(sql)) {
        return [{ timestamp: 1000 }];
      }
      return [];
    },
  };
}

describe("SessionSearchEngine", () => {
  it("searchMessages returns rows with route metadata", async () => {
    const backend = fakeBackend([
      {
        id: 1,
        session_id: "s1",
        role: "user",
        content: "hello",
        snippet: "hello",
        source: "chat",
        model: "gpt-4",
        session_started: 1234567890,
      },
    ]);
    const engine = new SessionSearchEngine({ backend });
    const result = await engine.searchMessages({ query: "hello", limit: 10 });
    expect(result.rows).toHaveLength(1);
    expect(result.route.strategy).toBe("unicode61");
    expect(result.totalRaw).toBe(1);
  });

  it("searchSessionsById maps session columns", async () => {
    const backend = fakeBackend();
    const engine = new SessionSearchEngine({ backend });
    const rows = await engine.searchSessionsById("s1", 5);
    expect(rows[0].session_id).toBe("s1");
  });

  it("readSession returns all messages", async () => {
    const backend = fakeBackend([
      { id: 1, session_id: "s1", role: "user", content: "hi" },
      { id: 2, session_id: "s1", role: "assistant", content: "yo" },
    ]);
    const engine = new SessionSearchEngine({ backend });
    const resp = await engine.readSession("s1");
    expect(resp.mode).toBe("read");
    expect(resp.results[0].messages).toHaveLength(2);
    expect(resp.results[0].link).toBe("@session:default/s1");
  });

  it("browse returns recent sessions", async () => {
    const backend = fakeBackend();
    const engine = new SessionSearchEngine({ backend });
    const resp = await engine.browse(5);
    expect(resp.mode).toBe("browse");
    expect(resp.results[0].session_id).toBe("s1");
  });

  it("discover returns lineage-deduped results", async () => {
    const backend = fakeBackend([
      { id: 10, session_id: "s1", role: "user", content: "人工智能", snippet: "人工智能" },
    ]);
    const engine = new SessionSearchEngine({ backend, profile: "dev" });
    const resp = await engine.discover("人工智能", { limit: 5, window: 2 });
    expect(resp.mode).toBe("discover");
    expect(resp.results[0].session_id).toBe("s1");
    expect(resp.results[0].link).toBe("@session:dev/s1");
  });

  it("scroll returns anchored window", async () => {
    const backend = fakeBackend([
      { id: 9, session_id: "s1", role: "user", content: "before" },
      { id: 10, session_id: "s1", role: "assistant", content: "anchor" },
      { id: 11, session_id: "s1", role: "user", content: "after" },
    ]);
    const engine = new SessionSearchEngine({ backend });
    const resp = await engine.scroll("s1", 10, 1);
    expect(resp.mode).toBe("scroll");
    expect(resp.results[0].messages).toHaveLength(3);
  });

  it("dispatchTool routes to browse when query is empty", async () => {
    const backend = fakeBackend();
    const engine = new SessionSearchEngine({ backend });
    const resp = await engine.dispatchTool({ query: "", limit: 10, window: 5, sort: "rank" });
    expect(resp.mode).toBe("browse");
  });
});
