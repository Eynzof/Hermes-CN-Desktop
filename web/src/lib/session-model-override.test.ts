import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetSessionModelOverridesForTests,
  forgetSessionModelOverride,
  readSessionModelOverride,
  rememberSessionModelOverride,
} from "./session-model-override";

describe("session-model-override", () => {
  beforeEach(() => __resetSessionModelOverridesForTests());

  it("returns null when nothing stored", () => {
    expect(readSessionModelOverride("abc")).toBeNull();
  });

  it("round-trips a selection by session id", () => {
    rememberSessionModelOverride("sess-1", {
      model: "deepseek-v4-pro",
      provider: "deepseek",
      providerName: "DeepSeek",
    });
    expect(readSessionModelOverride("sess-1")).toEqual({
      model: "deepseek-v4-pro",
      provider: "deepseek",
      providerName: "DeepSeek",
    });
  });

  it("isolates entries per session id", () => {
    rememberSessionModelOverride("s1", { model: "A", provider: "p" });
    rememberSessionModelOverride("s2", { model: "B", provider: "p" });
    expect(readSessionModelOverride("s1")?.model).toBe("A");
    expect(readSessionModelOverride("s2")?.model).toBe("B");
  });

  it("ignores selections without a model", () => {
    rememberSessionModelOverride("s1", { model: "" });
    expect(readSessionModelOverride("s1")).toBeNull();
  });

  it("forgets on demand", () => {
    rememberSessionModelOverride("s1", { model: "A", provider: "p" });
    forgetSessionModelOverride("s1");
    expect(readSessionModelOverride("s1")).toBeNull();
  });

  it("no-ops on empty session id", () => {
    rememberSessionModelOverride("", { model: "A" });
    expect(readSessionModelOverride("")).toBeNull();
  });
});
