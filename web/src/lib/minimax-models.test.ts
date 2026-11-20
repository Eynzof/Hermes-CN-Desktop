import { describe, expect, it } from "vitest";
import { currentTextModelChoices, MINIMAX_TEXT_MODELS } from "./minimax-models";

describe("current MiniMax text choices", () => {
  it.each(["minimax", "minimax-cn"])("refreshes stale %s lists without changing the saved choice", (provider) => {
    const stale = ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M3"];
    expect(currentTextModelChoices(provider, stale)).toEqual(MINIMAX_TEXT_MODELS);
    expect(currentTextModelChoices(provider, stale, "MiniMax-M2.7"))
      .toEqual([...MINIMAX_TEXT_MODELS, "MiniMax-M2.7"]);
    expect(stale).toEqual(["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M3"]);
  });

  it("keeps only advertised current gateway routes and preserves other capabilities", () => {
    expect(currentTextModelChoices("openrouter", [
      "minimax/minimax-m2.7", "minimax/minimax-m3", "minimax/minimax-m3.1-flash:free",
      "speech-2.8-hd", "image-01", "other-model",
    ])).toEqual([
      "minimax/minimax-m3.1-flash:free", "minimax/minimax-m3", "speech-2.8-hd", "image-01", "other-model",
    ]);
    expect(currentTextModelChoices("opencode", ["minimax-m2.5", "minimax-m3.1-flash-free"]))
      .toEqual(["minimax-m3.1-flash-free"]);
    expect(currentTextModelChoices("gateway", ["minimax-m2.5", "other-model"]))
      .toEqual(["other-model"]);
  });

  it("preserves explicitly custom and saved legacy identifiers", () => {
    const legacy = ["MiniMax-M2.7", "bespoke-model"];
    expect(currentTextModelChoices("custom:minimax-cn", legacy)).toEqual(legacy);
    expect(currentTextModelChoices("custom-draft", legacy)).toEqual(legacy);
    expect(currentTextModelChoices("private-service", legacy, undefined, true)).toEqual(legacy);
    expect(currentTextModelChoices("gateway", [], "minimax-m2.5")).toEqual(["minimax-m2.5"]);
  });
});
