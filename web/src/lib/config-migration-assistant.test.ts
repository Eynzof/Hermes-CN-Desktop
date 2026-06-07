import { describe, expect, it } from "vitest";
import {
  buildConfigMigrationAssistantPrompt,
  summarizeConfigMigrationRuntimeContext,
} from "./config-migration-assistant";

const context = {
  runtimeConfig: {
    currentProfile: "default",
    dashboardApiBaseUrl: "http://127.0.0.1:9120",
    gatewayUrl: "ws://127.0.0.1:9120/api/ws",
  },
  runtimeInfo: {
    mode: "managed",
    packaged: true,
    platform: "darwin",
    arch: "arm64",
    runtimeRoot: "/runtime",
    currentRecordPath: "/runtime/current.json",
    versionsDir: "/runtime/versions",
    downloadsDir: "/runtime/downloads",
    gatewayRuntimeDir: "/runtime/gateway",
    updatesConfigured: false,
    process: {
      apiBaseUrl: "http://127.0.0.1:9120",
      gatewayUrl: "ws://127.0.0.1:9120/api/ws",
      hermesHome: "/Users/alice/Library/Application Support/Hermes/default",
      hermesHomeBase: "/Users/alice/Library/Application Support/Hermes",
      currentProfile: "default",
      ownsProcess: true,
      commandArgs: [],
      sessionTokenPresent: true,
      gatewaySseProxyActive: true,
    },
  },
  collectedAt: "2026-06-07T05:00:00.000Z",
};

describe("config migration assistant prompt", () => {
  it("summarizes runtime context without requiring a native migration scan", () => {
    const summary = summarizeConfigMigrationRuntimeContext(context);
    expect(summary).toContain("当前桌面端 profile：default");
    expect(summary).toContain("桌面端当前 HERMES_HOME：/Users/alice/Library/Application Support/Hermes/default");
    expect(summary).toContain("Dashboard API：http://127.0.0.1:9120");
  });

  it("requires diagnosis and confirmation before any write", () => {
    const prompt = buildConfigMigrationAssistantPrompt(context);
    expect(prompt).toContain("必须先诊断、再给计划、等我明确确认后");
    expect(prompt).toContain("第一轮请只做诊断和提问，不要写文件");
    expect(prompt).toContain("任何写入前都要说明来源路径、目标路径");
  });

  it("covers complex real-world migration surfaces and secret handling", () => {
    const prompt = buildConfigMigrationAssistantPrompt(context);
    expect(prompt).toContain("WSL");
    expect(prompt).toContain("MCP server 配置");
    expect(prompt).toContain("不要在回复中打印原始 API Key");
    expect(prompt).toContain("备份目标 profile");
    expect(prompt).toContain("验证基础可用性");
  });
});
