import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  isSkillInvocationText,
  SkillInvocationMessage,
  skillInvocationPreview,
} from "./skill-invocation-message";

const singleSkill = [
  '[IMPORTANT: The user has invoked the "codex" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]',
  "",
  "# Codex",
  "",
  "Always use a PTY.",
].join("\n");

describe("SkillInvocationMessage", () => {
  it("recognizes single, bundle and stacked skill activation messages", () => {
    expect(isSkillInvocationText(singleSkill)).toBe(true);
    expect(isSkillInvocationText('[IMPORTANT: The user has invoked the "review" skill bundle, loading 2 skills together.]')).toBe(true);
    expect(isSkillInvocationText('[IMPORTANT: The user has invoked the "/a /b" stacked skill bundle, loading 2 skills together.]')).toBe(true);
  });

  it("does not collapse ordinary user messages", () => {
    expect(isSkillInvocationText("请帮我调用 codex skill 修复这个问题")).toBe(false);
    expect(isSkillInvocationText("引用：[IMPORTANT: The user has invoked the skill]")).toBe(false);
  });

  it("normalizes the collapsed preview into a compact line-clamped string", () => {
    expect(skillInvocationPreview("第一行\n\n  第二行\t第三行")).toBe("第一行 第二行 第三行");
  });

  it("renders collapsed by default with an accessible expand control", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <SkillInvocationMessage text={singleSkill} />,
    );

    expect(html).toContain('data-skill-invocation="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("展开 Skill 内容");
    expect(html).not.toContain("收起 Skill 内容");
  });
});
