import { describe, expect, it } from "vitest";
import type { PluginHubRow } from "@hermes/protocol";
import {
  filterPlugins,
  pluginCanToggle,
  pluginEffectiveStatus,
  summarizePlugins,
} from "./plugins";

function plugin(overrides: Partial<PluginHubRow>): PluginHubRow {
  return {
    name: "demo",
    kind: "standalone",
    author: "",
    version: "",
    description: "",
    source: "user",
    runtime_status: "inactive",
    provides_tools: [],
    provides_hooks: [],
    requires_env: [],
    missing_env: [],
    has_dashboard_manifest: false,
    path: "",
    can_remove: false,
    can_update_git: false,
    auth_required: false,
    auth_command: "",
    user_hidden: false,
    ...overrides,
  };
}

describe("plugin inventory helpers", () => {
  it("兼容旧 Core 的 runtime_status", () => {
    expect(pluginEffectiveStatus(plugin({ runtime_status: "enabled" }))).toBe("enabled");
    expect(pluginEffectiveStatus(plugin({ runtime_status: "disabled" }))).toBe("disabled");
    expect(pluginCanToggle(plugin({ kind: "standalone", can_toggle: undefined }))).toBe(true);
  });

  it("优先使用新版 effective_status 和只读标记", () => {
    const managed = plugin({
      kind: "model-provider",
      effective_status: "provider-managed",
      can_toggle: false,
    });
    expect(pluginEffectiveStatus(managed)).toBe("provider-managed");
    expect(pluginCanToggle(managed)).toBe(false);
  });

  it("汇总活跃、未启用、禁用和 Provider 管理状态", () => {
    expect(summarizePlugins([
      plugin({ effective_status: "enabled" }),
      plugin({ effective_status: "auto-active" }),
      plugin({ effective_status: "inactive" }),
      plugin({ effective_status: "disabled" }),
      plugin({ effective_status: "provider-managed" }),
    ])).toEqual({ total: 5, active: 2, inactive: 1, disabled: 1, providerManaged: 1 });
  });

  it("按来源、类型、状态和能力关键字筛选", () => {
    const rows = [
      plugin({
        name: "firecrawl",
        key: "web/firecrawl",
        kind: "backend",
        source: "bundled",
        effective_status: "auto-active",
        provides_tools: ["web_search"],
      }),
      plugin({ name: "local", source: "git", effective_status: "inactive" }),
    ];

    expect(filterPlugins(rows, {
      query: "web_search",
      source: "bundled",
      kind: "backend",
      status: "auto-active",
    }).map((row) => row.name)).toEqual(["firecrawl"]);
  });
});
