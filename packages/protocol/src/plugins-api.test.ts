import { describe, expect, it } from "vitest";
import { PluginsHubResponse } from "./hermes-api";

describe("PluginsHubResponse", () => {
  it("兼容只有旧字段的 Core 响应", () => {
    const parsed = PluginsHubResponse.parse({
      plugins: [{
        name: "demo",
        version: "1.0.0",
        description: "demo plugin",
        source: "user",
        runtime_status: "enabled",
        path: "/tmp/demo",
        can_remove: true,
        can_update_git: false,
        auth_required: false,
        auth_command: "",
        user_hidden: false,
      }],
      providers: {
        memory_provider: "",
        memory_options: [],
        context_engine: "compressor",
        context_options: [],
      },
    });

    expect(parsed.plugins[0]).toMatchObject({
      name: "demo",
      kind: "standalone",
      runtime_status: "enabled",
      provides_tools: [],
      missing_env: [],
    });
    expect(parsed.plugins[0].can_toggle).toBeUndefined();
  });

  it("保留新版清单、状态和能力字段", () => {
    const parsed = PluginsHubResponse.parse({
      plugins: [{
        name: "openai",
        key: "image_gen/openai",
        kind: "backend",
        author: "Nous Research",
        source: "bundled",
        runtime_status: "enabled",
        config_status: "auto",
        effective_status: "auto-active",
        can_toggle: true,
        provides_tools: ["image_generation"],
        provides_hooks: ["on_session_end"],
        requires_env: ["OPENAI_API_KEY"],
        missing_env: ["OPENAI_API_KEY"],
      }],
      providers: {},
      future_field: true,
    });

    expect(parsed.plugins[0]).toMatchObject({
      key: "image_gen/openai",
      config_status: "auto",
      effective_status: "auto-active",
      provides_tools: ["image_generation"],
      missing_env: ["OPENAI_API_KEY"],
    });
  });
});
