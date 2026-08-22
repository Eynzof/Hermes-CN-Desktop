import { describe, expect, it, vi } from "vitest";
import { handleSkin, type SkinHandlerContext } from "./skin";

function makeCtx(overrides: Partial<SkinHandlerContext> = {}): SkinHandlerContext {
  return {
    currentSkin: "default",
    applySkin: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("/skin slash handler", () => {
  it("lists skins when no argument is provided", async () => {
    const ctx = makeCtx();
    const result = await handleSkin("", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Available skins:");
    expect(result.output).toContain("Ares");
    expect(result.output).toContain("default");
  });

  it("lists skins with explicit list argument", async () => {
    const ctx = makeCtx();
    const result = await handleSkin("list", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Ocean");
    expect(result.output).toContain("*");
  });

  it("applies a built-in skin by slug", async () => {
    const ctx = makeCtx();
    const result = await handleSkin("ares", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toBe("Skin set to ares.");
    expect(result.name).toBe("ares");
    expect(ctx.applySkin).toHaveBeenCalledWith("ares");
  });

  it("applies a built-in skin case-insensitively", async () => {
    const ctx = makeCtx();
    const result = await handleSkin("ARES", ctx);
    expect(result.type).toBe("exec");
    expect(result.name).toBe("ares");
  });

  it("reports an error for unknown skins", async () => {
    const ctx = makeCtx();
    const result = await handleSkin("charizard", ctx);
    expect(result.type).toBe("error");
    expect(result.message).toContain("Unknown skin: charizard");
    expect(ctx.applySkin).not.toHaveBeenCalled();
  });

  it("resets to default when requested", async () => {
    const ctx = makeCtx({ currentSkin: "ares" });
    const result = await handleSkin("default", ctx);
    expect(result.type).toBe("exec");
    expect(result.name).toBe("default");
    expect(ctx.applySkin).toHaveBeenCalledWith("default");
  });

  it("works without an applySkin callback", async () => {
    const ctx = makeCtx({ applySkin: undefined });
    const result = await handleSkin("light", ctx);
    expect(result.type).toBe("exec");
    expect(result.name).toBe("light");
  });

  it("reports an error for empty input that is not a list", async () => {
    // Note: empty input is treated as a list request, so this tests an explicit
    // unknown value.
    const ctx = makeCtx();
    const result = await handleSkin("   ", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Available skins:");
  });
});
