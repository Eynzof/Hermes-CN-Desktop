import { describe, expect, it } from "vitest";
import { getProviderIconUrl } from "./provider-icons";

describe("provider icon registry", () => {
  it.each(["gemini", "openai", "anthropic", "xai", "agnes"])(
    "resolves the %s brand icon",
    (icon) => {
      expect(getProviderIconUrl(icon)).toEqual(expect.any(String));
      expect(getProviderIconUrl(icon)).not.toBe("");
    },
  );

  it("keeps unknown icon keys on the initial-letter fallback path", () => {
    expect(getProviderIconUrl("unknown-provider")).toBeUndefined();
    expect(getProviderIconUrl(undefined)).toBeUndefined();
  });
});
