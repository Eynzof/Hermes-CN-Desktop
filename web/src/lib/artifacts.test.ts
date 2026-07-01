import { describe, expect, it } from "vitest";
import { collectArtifactsForSession } from "./artifacts";
import type { SessionMessage, SessionSummary } from "@hermes/protocol";

const session = {
  id: "s1",
  title: "Build assets",
  preview: "",
  started_at: 10,
  ended_at: 20,
  profile: "coder",
} as SessionSummary;

function message(input: Partial<SessionMessage>): SessionMessage {
  return {
    id: 1,
    session_id: "s1",
    role: "assistant",
    content: "",
    images: undefined,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    timestamp: 100,
    token_count: null,
    finish_reason: null,
    reasoning: null,
    reasoning_details: null,
    codex_reasoning_items: null,
    reasoning_content: null,
    ...input,
  };
}

describe("collectArtifactsForSession", () => {
  it("extracts images, files, and links with source metadata", () => {
    const items = collectArtifactsForSession(session, [
      message({
        content: "See https://example.com/report and E:\\work\\out\\chart.png",
        images: [{ url: "data:image/png;base64,abc" }],
      }),
    ]);

    expect(items.map((item) => item.kind).sort()).toEqual(["image", "image", "link"]);
    expect(items.every((item) => item.sessionId === "s1")).toBe(true);
    expect(items.every((item) => item.profile === "coder")).toBe(true);
  });

  it("deduplicates repeated values within a session", () => {
    const items = collectArtifactsForSession(session, [
      message({ content: "https://example.com/a.png https://example.com/a.png" }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("image");
  });
});
