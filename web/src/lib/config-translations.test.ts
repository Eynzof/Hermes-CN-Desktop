import { describe, expect, it } from "vitest";
import { translateConfigField, translateConfigOption } from "./config-translations";

describe("translateConfigField", () => {
  it("returns the Chinese label for a known field key", () => {
    expect(translateConfigField("terminal.backend", "Terminal Backend")).toBe("终端执行后端");
  });

  it("falls back to the backend-provided English for an unknown key", () => {
    expect(translateConfigField("some.unknown.key", "Some → Unknown → Key")).toBe(
      "Some → Unknown → Key",
    );
  });

  it("builds auxiliary slot labels algorithmically (task · field)", () => {
    expect(translateConfigField("auxiliary.vision.provider", "Auxiliary → Vision → Provider")).toBe(
      "视觉分析 · 提供商",
    );
    expect(translateConfigField("auxiliary.web_extract.timeout", "x")).toBe("网页抽取 · 调用超时（秒）");
  });

  it("falls back gracefully for an unknown auxiliary task or field", () => {
    expect(translateConfigField("auxiliary.brand_new_task.provider", "x")).toBe(
      "brand_new_task · 提供商",
    );
  });
});

describe("translateConfigOption", () => {
  it("translates descriptive enum values", () => {
    expect(translateConfigOption("approvals.mode", "yolo")).toBe("全部放行");
    expect(translateConfigOption("delegation.reasoning_effort", "high")).toBe("高");
  });

  it("keeps brand / technical enum values as-is when unmapped", () => {
    expect(translateConfigOption("terminal.backend", "docker")).toBe("docker");
    expect(translateConfigOption("tts.provider", "elevenlabs")).toBe("elevenlabs");
  });

  it("renders the empty option as the default placeholder", () => {
    expect(translateConfigOption("agent.service_tier", "")).toBe("(默认)");
  });
});
