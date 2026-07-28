import { describe, expect, it } from "vitest";
import { buildSessionCreateParams } from "./session-create";

describe("buildSessionCreateParams", () => {
  it("sends the selected provider and model with session.create", () => {
    expect(buildSessionCreateParams({
      cwd: " C:/work/project ",
      model: " deepseek-v4-flash ",
      provider: " deepseek ",
      activate: false,
    })).toEqual({
      cwd: "C:/work/project",
      model: "deepseek-v4-flash",
      provider: "deepseek",
    });
  });

  it("omits empty values and desktop-only activation metadata", () => {
    expect(buildSessionCreateParams({ activate: true, model: " " })).toEqual({});
  });
});
