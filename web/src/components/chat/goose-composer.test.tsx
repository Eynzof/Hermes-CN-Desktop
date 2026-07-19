import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { ComposerErrorMessage, GooseComposer, isComposerComposing } from "./goose-composer";

function renderComposer(element: ReactElement): string {
  return ReactDOMServer.renderToStaticMarkup(
    <MemoryRouter>
      {element}
    </MemoryRouter>,
  );
}

describe("ComposerErrorMessage", () => {
  it("shows a voice setup action for missing STT provider errors", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ComposerErrorMessage
        message="语音识别尚未配置可用提供方。请到“语音”设置选择本地识别。"
        onConfigureVoice={() => {}}
      />,
    );

    expect(html).toContain("语音识别尚未配置可用提供方");
    expect(html).toContain("去配置语音");
  });

  it("does not show a voice setup action for generic composer errors", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ComposerErrorMessage message="发送失败" onConfigureVoice={() => {}} />,
    );

    expect(html).toContain("发送失败");
    expect(html).not.toContain("去配置语音");
  });
});

describe("GooseComposer IME guard", () => {
  it("keeps keydown handlers suspended until the delayed composition state resets", () => {
    expect(isComposerComposing({ tracked: true, native: false })).toBe(true);
    expect(isComposerComposing({ tracked: false, native: true })).toBe(true);
    expect(isComposerComposing({ tracked: false, native: false })).toBe(false);
  });
});

describe("GooseComposer slash hints", () => {
  it("renders new-task slash hints without the compress command", () => {
    const html = renderComposer(
      <GooseComposer
        hints={[
          { kbd: "/skill", label: "选择 Skill" },
          { kbd: "/", label: "输入指令" },
          { label: "把文件拖入此处直接附加" },
        ]}
        showCompressCommand={false}
      />,
    );

    expect(html).toContain("/skill");
    expect(html).toContain("选择 Skill");
    expect(html).toContain("输入指令");
    expect(html).toContain("把文件拖入此处直接附加");
    expect(html).not.toContain("/compress");
  });

  it("renders session slash hints with the compress command", () => {
    const html = renderComposer(
      <GooseComposer
        hints={[
          { kbd: "/skill", label: "选择 Skill" },
          { kbd: "/", label: "输入指令" },
          { kbd: "/compress", label: "触发会话压缩" },
        ]}
      />,
    );

    expect(html).toContain("/skill");
    expect(html).toContain("输入指令");
    expect(html).toContain("/compress");
    expect(html).toContain("触发会话压缩");
  });
});

describe("GooseComposer workspace picker", () => {
  it("renders a clear workspace action when a workspace is selected", () => {
    const html = renderComposer(
      <GooseComposer initialWorkspacePath="/Users/enzo/Project" />,
    );

    expect(html).toContain("Project");
    expect(html).toContain("不指定默认工作区：/Users/enzo/Project");
  });

  it("does not render the clear workspace action without a selected workspace", () => {
    const html = renderComposer(<GooseComposer />);

    expect(html).not.toContain("不指定默认工作区：");
  });
});
