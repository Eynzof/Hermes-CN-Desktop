import { describe, expect, it } from "vitest";
import { modelChoiceKey, parseModelChoiceKey } from "./profile-model-key";

describe("model choice key", () => {
  it("round-trips provider + model", () => {
    const key = modelChoiceKey("anthropic", "claude-opus-4-8");
    expect(parseModelChoiceKey(key)).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
  });

  it("only splits on the first separator (model ids may contain anything but NUL)", () => {
    // model id 里出现 ':' / '/' 之类都不影响，分隔符是 NUL。
    const key = modelChoiceKey("openrouter", "anthropic/claude-3.5:beta");
    expect(parseModelChoiceKey(key)).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3.5:beta",
    });
  });

  it("returns null for an empty key (the 'none / keep' option)", () => {
    expect(parseModelChoiceKey("")).toBeNull();
  });

  it("returns null when there is no separator", () => {
    expect(parseModelChoiceKey("not-a-real-key")).toBeNull();
  });
});
