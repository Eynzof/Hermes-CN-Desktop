import { describe, expect, it } from "vitest";
import { CN_BACKEND_PROVIDER_SLUGS } from "./cn-provider-slugs";

describe("CN backend provider slug filter", () => {
  it("keeps official direct providers and excludes deprecated or relay-only defaults", () => {
    expect(CN_BACKEND_PROVIDER_SLUGS).toContain("stepfun");
    expect(CN_BACKEND_PROVIDER_SLUGS).toContain("xiaomi");
    expect(CN_BACKEND_PROVIDER_SLUGS).toContain("openai-codex");
    expect(CN_BACKEND_PROVIDER_SLUGS).toContain("openrouter");
    expect(CN_BACKEND_PROVIDER_SLUGS).not.toContain("qwen-oauth");
    expect(CN_BACKEND_PROVIDER_SLUGS).not.toContain("tencent-tokenhub");
  });
});
