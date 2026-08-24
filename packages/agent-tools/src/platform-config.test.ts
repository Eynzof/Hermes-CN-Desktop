import { describe, it, expect } from "vitest";
import {
  getPlatformTools,
  savePlatformTools,
  enableToolset,
  disableToolset,
  upsertCustomToolset,
  deleteCustomToolset,
  PLATFORMS,
} from "./platform-config.js";
import type { ToolConfigLike } from "./types.js";

const baseConfig: ToolConfigLike = {
  platform_toolsets: {
    cli: ["hermes_cli"],
  },
};

describe("getPlatformTools", () => {
  it("returns default cli bundle", () => {
    const res = getPlatformTools(baseConfig, "cli");
    expect(res.enabled).toContain("hermes_cli");
    expect(res.enabled).toContain("core");
    expect(res.enabled).toContain("file");
  });

  it("keeps default-off toolsets disabled unless explicit", () => {
    const res = getPlatformTools(baseConfig, "cli");
    expect(res.enabled).not.toContain("browser");
    expect(res.enabled).not.toContain("kanban");
  });

  it("auto-enables credential-gated toolsets when env present", () => {
    const res = getPlatformTools(baseConfig, "cli", {
      autoEnableCredentials: true,
      env: { XAI_API_KEY: "x" },
    });
    expect(res.enabled).toContain("x_search");
  });

  it("applies agent.disabled_toolsets last", () => {
    const cfg: ToolConfigLike = {
      ...baseConfig,
      agent: { disabled_toolsets: ["web"] },
    };
    const res = getPlatformTools(cfg, "cli");
    expect(res.enabled).not.toContain("web");
  });

  it("surfaces desktop_ui/project on gui sessions", () => {
    const res = getPlatformTools(baseConfig, "cli", { isGuiSession: true });
    expect(res.enabled).toContain("desktop_ui");
    expect(res.enabled).toContain("project");
  });
});

describe("savePlatformTools", () => {
  it("persists platform toolsets", () => {
    const next = savePlatformTools(baseConfig, "cron", ["hermes_cli"]);
    expect(next.platform_toolsets?.cron).toEqual(["hermes_cli"]);
  });
});

describe("enableToolset / disableToolset", () => {
  it("enables a toolset", () => {
    const next = enableToolset(baseConfig, "cli", "browser");
    const res = getPlatformTools(next, "cli");
    expect(res.enabled).toContain("browser");
  });

  it("disables a toolset", () => {
    const cfg = enableToolset(baseConfig, "cli", "browser");
    const next = disableToolset(cfg, "cli", "browser");
    const res = getPlatformTools(next, "cli");
    expect(res.enabled).not.toContain("browser");
  });
});

describe("custom toolsets", () => {
  it("upserts a custom toolset", () => {
    const next = upsertCustomToolset(baseConfig, {
      name: "ops",
      tools: ["terminal_run"],
      includes: ["core"],
      description: "ops bundle",
    });
    expect(next.custom_toolsets?.ops.tools).toContain("terminal_run");
  });

  it("deletes a custom toolset", () => {
    const cfg = upsertCustomToolset(baseConfig, {
      name: "ops",
      tools: [],
      includes: [],
      description: "",
    });
    const next = deleteCustomToolset(cfg, "ops");
    expect(next.custom_toolsets?.ops).toBeUndefined();
  });
});

describe("PLATFORMS", () => {
  it("lists the seven supported platforms in order", () => {
    expect(PLATFORMS).toEqual(["cli", "cron", "api-server", "telegram", "discord", "desktop", "webhook"]);
  });

  it("contains no duplicate platforms", () => {
    expect(new Set(PLATFORMS).size).toBe(PLATFORMS.length);
  });
});
