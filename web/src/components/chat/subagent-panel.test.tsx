import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CliDelegationEntry } from "@/stores/cli-delegations";
import { CliDelegationDetails } from "./subagent-panel";

function entry(overrides: Partial<CliDelegationEntry> = {}): CliDelegationEntry {
  return {
    id: "delegation-1",
    agent: "codex",
    origin: "events",
    execution: "foreground",
    status: "completed",
    promptExcerpt: "测试委派详情",
    startedAt: 1,
    outputTail: "",
    timeline: [],
    ...overrides,
  };
}

describe("CliDelegationDetails", () => {
  it("将会话、目录和 Token 渲染为三个独立复制行", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <CliDelegationDetails
        entry={entry({
          workdir: "/private/var/folders/a/very-long-work-directory",
          result: {
            sessionId: "019fa674-7d3e-7530-b7ba-3995815e6988",
            totalTokens: 31_040,
          },
        })}
        running={false}
      />,
    );

    expect(html.match(/data-cli-detail-row=/g)).toHaveLength(3);
    expect(html.match(/data-copyable="true"/g)).toHaveLength(3);
    expect(html).toContain("会话");
    expect(html).toContain("目录");
    expect(html).toContain("Token");
    expect(html).toContain("31.0k");
    expect(html).toContain("点击复制会话");
    expect(html).toContain("点击复制目录");
    expect(html).toContain("点击复制Token");
  });

  it("运行中缺失的数据仍占三行但不可复制", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <CliDelegationDetails entry={entry({ status: "running" })} running />,
    );

    expect(html.match(/data-cli-detail-row=/g)).toHaveLength(3);
    expect(html.match(/data-copyable="false"/g)).toHaveLength(3);
    expect(html).toContain("获取中");
    expect(html).toContain("统计中");
    expect(html).not.toContain("点击复制");
  });
});
