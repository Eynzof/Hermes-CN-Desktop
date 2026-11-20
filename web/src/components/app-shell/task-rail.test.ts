import { describe, expect, it } from "vitest";
import { ASSISTANT_ROUTE, matchesAssistantRoute } from "./task-rail";

describe("task rail assistant navigation", () => {
  it("opens the unified assistant page below new task", () => {
    expect(ASSISTANT_ROUTE).toBe("/assistant");
    expect(matchesAssistantRoute("/assistant")).toBe(true);
    expect(matchesAssistantRoute("/assistant/feishu")).toBe(true);
  });

  it("keeps legacy IM deep links highlighted", () => {
    expect(matchesAssistantRoute("/im/weixin")).toBe(true);
    expect(matchesAssistantRoute("/projects")).toBe(false);
    expect(matchesAssistantRoute("/assistants")).toBe(false);
  });
});
