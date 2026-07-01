import { describe, expect, it } from "vitest";
import { reduceSubagentList } from "./subagents";

describe("subagent child sessions", () => {
  it("maps child_session_id to sessionId and preserves it on later events", () => {
    const first = reduceSubagentList(
      [],
      { subagent_id: "a1", goal: "watch me", status: "running", child_session_id: "child-123" },
      true,
      "subagent.start",
      100,
    );
    const second = reduceSubagentList(
      first,
      { subagent_id: "a1", status: "running", text: "still running" },
      true,
      "subagent.progress",
      120,
    );

    expect(second[0]?.sessionId).toBe("child-123");
  });
});
