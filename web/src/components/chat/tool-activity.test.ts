import { describe, expect, it } from "vitest";
import type { ChatToolItem } from "./chat-types";
import { summarizeToolActivity } from "./tool-activity";

function tool(overrides: Partial<ChatToolItem> = {}): ChatToolItem {
  return {
    tool_id: overrides.tool_id ?? "tool-1",
    name: overrides.name ?? "terminal",
    status: overrides.status ?? "done",
    startedAt: overrides.startedAt ?? 1_000,
    completedAt: overrides.completedAt ?? 1_300,
    ...overrides,
  };
}

describe("summarizeToolActivity", () => {
  it("collapses repeated terminal commands into one summary", () => {
    const summary = summarizeToolActivity(
      Array.from({ length: 10 }, (_, index) =>
        tool({
          tool_id: `terminal-${index}`,
          startedAt: 1_000 + index * 100,
          completedAt: 1_050 + index * 100,
        }),
      ),
      5_000,
    );

    expect(summary.status).toBe("done");
    expect(summary.label).toBe("运行了 10 条终端命令");
    expect(summary.meta).toBeUndefined();
    expect(summary.elapsedMs).toBe(950);
  });

  it("summarizes mixed tool batches by count", () => {
    const summary = summarizeToolActivity([
      tool({ tool_id: "terminal-1", name: "terminal" }),
      tool({ tool_id: "terminal-2", name: "terminal" }),
      tool({ tool_id: "read-1", name: "file_read" }),
      tool({ tool_id: "edit-1", name: "edit" }),
    ]);

    expect(summary.status).toBe("done");
    expect(summary.label).toBe("使用了 4 个工具");
    expect(summary.meta).toContain("terminal x2");
    expect(summary.meta).toContain("edit x1");
    expect(summary.meta).toContain("file_read x1");
  });

  it("keeps running batches visible with elapsed time", () => {
    const summary = summarizeToolActivity(
      [tool({ status: "running", startedAt: 1_000, completedAt: undefined })],
      2_500,
    );

    expect(summary.status).toBe("running");
    expect(summary.label).toBe("正在运行终端命令");
    expect(summary.elapsedMs).toBe(1_500);
  });

  it("surfaces errors in the collapsed summary", () => {
    const summary = summarizeToolActivity([
      tool({ tool_id: "terminal-1", name: "terminal" }),
      tool({
        tool_id: "read-1",
        name: "file_read",
        status: "error",
        error: "permission denied",
        completedAt: 1_400,
      }),
    ]);

    expect(summary.status).toBe("error");
    expect(summary.label).toBe("使用了 2 个工具，1 个失败");
    expect(summary.error).toBe("permission denied");
  });
});
