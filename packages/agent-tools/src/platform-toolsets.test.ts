import { describe, expect, it } from "vitest";
import { getPlatformToolsetNames, PLATFORM_TOOLSETS, resolvePlatformToolset } from "./platform-toolsets.js";

describe("platform-toolsets", () => {
  it("includes all target platform keys", () => {
    const names = getPlatformToolsetNames();
    expect(names).toContain("hermes-cli");
    expect(names).toContain("hermes-acp");
    expect(names).toContain("hermes-api-server");
    expect(names).toContain("hermes-cron");
    expect(names).toContain("hermes-webhook");
    expect(names).toContain("hermes-gateway");
  });

  it("resolves hermes-cli to core tools", () => {
    const tools = resolvePlatformToolset("hermes-cli");
    expect(tools.has("terminal_run")).toBe(true);
    expect(tools.has("web_search")).toBe(true);
  });

  it("resolves hermes-webhook to safe subset only", () => {
    const tools = resolvePlatformToolset("hermes-webhook");
    expect(tools.has("web_search")).toBe(true);
    expect(tools.has("terminal_run")).toBe(false);
  });

  it("resolves gateway union includes cli", () => {
    const tools = resolvePlatformToolset("hermes-gateway");
    expect(tools.has("terminal_run")).toBe(true);
  });

  it("hermes-acp drops clarify and image_generate", () => {
    const tools = resolvePlatformToolset("hermes-acp");
    expect(tools.has("clarify")).toBe(false);
    expect(tools.has("image_generate")).toBe(false);
    expect(tools.has("file_read")).toBe(true);
  });
});
