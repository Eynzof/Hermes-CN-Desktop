import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sessionLogToMessages } from "./session-log.js";
import type { SessionMessage } from "./hermes-api.js";

/**
 * Shared golden-fixture parity test.
 *
 * The same JSON files drive the Rust integration test
 * `tests/protocol_schema.rs::session_log_parser_matches_ts_snapshot`
 * (via `tests/fixtures/protocol/session_log_{input,output}.json`). This test
 * runs the TS `sessionLogToMessages` against the same input and asserts the
 * exact same output, locking TS↔Rust parity for the session-log transform.
 */
function loadFixture(name: string): Record<string, unknown> {
  const url = new URL(`../../../tests/fixtures/protocol/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

describe("sessionLogToMessages parity with Rust golden fixtures", () => {
  it("matches the shared session_log_output fixture", () => {
    const input = loadFixture("session_log_input");
    const expected = loadFixture("session_log_output") as {
      session_id: string;
      messages: SessionMessage[];
    };
    const actual = sessionLogToMessages("s-1", input);
    expect(actual).toEqual(expected.messages);
  });

  it("skips unknown roles and non-object entries while preserving original indices", () => {
    const actual = sessionLogToMessages("s-1", {
      session_start: "2024-01-01T00:00:00Z",
      messages: [
        null,
        "string",
        { role: "unknown", content: "x" },
        { role: "user", content: "hi" },
        { role: "tool", content: { result: "ok" } },
      ],
    });
    expect(actual).toEqual([
      expect.objectContaining({ id: 4, role: "user", content: "hi", timestamp: 1704067203 }),
      expect.objectContaining({
        id: 5,
        role: "tool",
        content: '{"result":"ok"}',
        timestamp: 1704067204,
      }),
    ]);
  });
});
