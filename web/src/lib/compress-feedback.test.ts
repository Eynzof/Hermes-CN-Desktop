import { describe, expect, it } from "vitest";
import { formatCompressNotice } from "./compress-feedback";

describe("formatCompressNotice", () => {
  it("summarises a real compaction with message and token deltas", () => {
    const text = formatCompressNotice({
      status: "compressed",
      removed: 12,
      before_messages: 40,
      after_messages: 8,
      before_tokens: 85_000,
      after_tokens: 12_000,
    });
    expect(text).toBe("已压缩上下文：40 → 8 条消息，约 85.0k → 12.0k tokens。");
  });

  it("reports a no-op when nothing was removed", () => {
    const text = formatCompressNotice({
      status: "compressed",
      removed: 0,
      before_messages: 6,
      after_messages: 6,
      before_tokens: 9_000,
      after_tokens: 9_000,
    });
    expect(text).toBe("上下文无需压缩：当前6 条消息、约 9.0k tokens。");
  });

  it("includes the focus topic when provided", () => {
    const text = formatCompressNotice(
      { removed: 3, before_messages: 20, after_messages: 10, before_tokens: 50_000, after_tokens: 30_000 },
      "保留鉴权相关讨论",
    );
    expect(text).toBe(
      "已压缩上下文（聚焦：保留鉴权相关讨论）：20 → 10 条消息，约 50.0k → 30.0k tokens。",
    );
  });

  it("degrades gracefully when the backend omits counts", () => {
    expect(formatCompressNotice({ status: "compressed", removed: 5 })).toBe("已压缩上下文。");
  });
});
