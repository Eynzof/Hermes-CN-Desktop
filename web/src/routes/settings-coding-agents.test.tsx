import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CodingAgentStatus, SkillInfo } from "@hermes/protocol";
import { CodingAgentToolbar, DelegationSkillControl } from "./settings-coding-agents";

const agent: CodingAgentStatus = {
  id: "codex",
  label: "Codex",
  installed: true,
  version: "codex-cli 0.145.0",
  path: "/Users/example/.local/bin/codex",
  loginState: "logged_in",
  loginDetail: "已通过 ChatGPT 账号登录",
  configDir: "/Users/example/.codex",
  skillName: "codex",
  installHint: "npm install -g @openai/codex",
  loginHint: "codex login",
};

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: "codex",
    description: "Delegate coding tasks to Codex",
    category: "coding",
    enabled: true,
    ...overrides,
  };
}

describe("DelegationSkillControl", () => {
  it("将技能名称、状态、说明和操作渲染为独立的委派设置区", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <DelegationSkillControl
        agent={agent}
        skill={skill()}
        onToggle={() => undefined}
        pending={false}
      />,
    );

    expect(html).toContain('data-delegation-skill="true"');
    expect(html).toContain('data-state="enabled"');
    expect(html).toContain('aria-label="Codex 委派技能"');
    expect(html).toContain("委派技能");
    expect(html).toContain("codex");
    expect(html).toContain("已启用");
    expect(html).toContain("停用技能");
    expect(html).toContain("Hermes 会通过此技能把编码任务交给 Codex");
    expect(html).not.toContain("hermes 委派技能「");
  });

  it("技能缺失时使用完整的告警区域而不是裸提示文字", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <DelegationSkillControl
        agent={agent}
        skill={undefined}
        onToggle={() => undefined}
        pending={false}
      />,
    );

    expect(html).toContain('data-state="missing"');
    expect(html).toContain('role="status"');
    expect(html).toContain("未找到");
    expect(html).toContain("请升级或重新同步内核技能后再试");
    expect(html).not.toContain("<button");
  });
});

describe("CodingAgentToolbar", () => {
  it("为两个顶部操作使用同一按钮规格", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <CodingAgentToolbar
        isFetching={false}
        hasBridge
        onRefresh={() => undefined}
        diagnostics={() => "{}"}
      />,
    );

    expect(html).toContain('role="toolbar"');
    expect(html.match(/data-coding-agent-action="true"/g)).toHaveLength(2);
    expect(html).toContain("刷新检测");
    expect(html).toContain("复制诊断 JSON");
  });
});
