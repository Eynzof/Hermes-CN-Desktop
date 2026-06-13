import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerErrorMessage } from "./goose-composer";

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

