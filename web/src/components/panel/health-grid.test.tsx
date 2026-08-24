import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, any>,
  env: {} as Record<string, any>,
  modelInfo: null as { model?: string; provider?: string } | null,
  status: null as Record<string, any> | null,
  oauthProviders: [] as Array<{ id: string; status: { logged_in?: boolean } }>,
  lastUsedModel: null as { model?: string; provider?: string } | null,
  runtimeInfo: null as Record<string, any> | null,
}));

vi.mock("@/hooks/use-status", () => ({
  useStatus: () => ({ data: mocks.status, isError: false, isFetching: false }),
}));

vi.mock("@/hooks/use-config", () => ({
  useConfig: () => ({ data: mocks.config, isError: false, isFetching: false }),
  useModelInfo: () => ({ data: mocks.modelInfo, isError: false, isFetching: false }),
}));

vi.mock("@/hooks/use-env", () => ({
  useEnvVars: () => ({ data: mocks.env, isError: false, isFetching: false }),
}));

vi.mock("@/hooks/use-skills", () => ({
  useSkills: () => ({ data: [], isError: false, isFetching: false }),
}));

vi.mock("@/hooks/use-mcp-servers", () => ({
  useMcpServers: () => ({ data: null, isError: false, isFetching: false }),
}));

vi.mock("@/hooks/use-oauth-providers", () => ({
  useOAuthProviders: () => ({ data: mocks.oauthProviders, isError: false, isFetching: false }),
}));

vi.mock("@/lib/last-used-model", () => ({
  useLastUsedModel: () => mocks.lastUsedModel,
}));

vi.mock("@/hooks/use-runtime-update", () => ({
  useRuntimeInfo: () => ({ data: mocks.runtimeInfo, isError: false, isFetching: false }),
}));

import { HealthGrid } from "./health-grid";

function renderHealthGrid(): string {
  return ReactDOMServer.renderToStaticMarkup(
    <MemoryRouter>
      <HealthGrid />
    </MemoryRouter>,
  );
}

/** 提取某个健康项卡片（按 label 文本）的 HTML 片段。 */
function healthItemHtml(html: string, label: string): string {
  const blocks = html.split(/(?=<(?:div|button)[^>]*class="_item[^"]*"[^>]*data-tone=)/);
  const block = blocks.find((part) => part.includes(label));
  expect(block, `health item ${label} should be rendered`).toBeTruthy();
  return block!;
}

function resetMocks() {
  mocks.config = {};
  mocks.env = {};
  mocks.modelInfo = null;
  mocks.status = {
    gateway_running: true,
    gateway_state: "running",
    gateway_health_url: "http://127.0.0.1:9120/api/health",
    hermes_home: "C:\\Users\\test\\.hermes",
    version: "1.0.0",
    active_sessions: 0,
  };
  mocks.oauthProviders = [];
  mocks.lastUsedModel = null;
  mocks.runtimeInfo = null;
}

describe("HealthGrid 模型凭证", () => {
  it("已保存 DS provider 内联 api_key（模型 deepseek-v4-flash-official）时显示「已配置」而不是「未配置」", () => {
    resetMocks();
    // 用户已在模型设置里保存了一个 DS provider：api_key 写在 config.providers，
    // 没有任何 *_API_KEY 环境变量，也没有 OAuth。
    mocks.config = {
      model: {
        provider: "ds",
        default: "deepseek-v4-flash-official",
        api_key: "sk-test-ds-key",
      },
      providers: {
        ds: {
          name: "DS",
          base_url: "https://api.deepseek.com/v1",
          model: "deepseek-v4-flash-official",
          api_key: "sk-test-ds-key",
        },
      },
    };
    mocks.modelInfo = {
      provider: "ds",
      model: "deepseek-v4-flash-official",
    };

    const html = renderHealthGrid();
    const tokenItem = healthItemHtml(html, "模型凭证");

    expect(tokenItem).toContain("已配置");
    expect(tokenItem).not.toContain("未配置");
  });

  it("只配置了目录里 provider 的环境变量（如 DASHSCOPE_API_KEY）也显示「已配置」", () => {
    resetMocks();
    mocks.env = {
      DASHSCOPE_API_KEY: {
        is_set: true,
        redacted_value: "sk-...tail",
        description: "",
        url: null,
        category: "provider",
        is_password: true,
        tools: [],
        advanced: false,
      },
    };
    mocks.modelInfo = {
      provider: "alibaba",
      model: "qwen3-coder-plus",
    };

    const html = renderHealthGrid();
    const tokenItem = healthItemHtml(html, "模型凭证");

    expect(tokenItem).toContain("已配置");
    expect(tokenItem).not.toContain("未配置");
  });

  it("Hermes Home 在 status 缺 hermes_home 时回退到桌面稳定工作目录（不再显示「正在读取数据目录」）", () => {
    resetMocks();
    // Local-first /api/status（以及 gated/remote 后端）会省略 hermes_home：
    // 桌面端的 HERMES_HOME 是启动时就固定的稳定工作目录，应该从
    // runtime_info.process.hermesHome 兜底展示，而不是永远停在读取中。
    mocks.status = {
      gateway_running: true,
      gateway_state: "running",
      gateway_health_url: "http://127.0.0.1:9120/api/health",
      version: "1.0.0",
      active_sessions: 0,
      // 故意不带 hermes_home —— 模拟 local-first stub / gated 后端。
    };
    mocks.runtimeInfo = {
      mode: "managed",
      packaged: false,
      platform: "win32",
      arch: "x64",
      runtimeRoot: "",
      currentRecordPath: "",
      versionsDir: "",
      downloadsDir: "",
      gatewayRuntimeDir: "",
      updatesConfigured: false,
      process: {
        apiBaseUrl: "http://127.0.0.1:9120",
        gatewayUrl: "ws://127.0.0.1:9120/api/ws",
        hermesHome: "C:\\Users\\test\\.hermes",
        hermesHomeBase: "C:\\Users\\test\\.hermes",
        currentProfile: "default",
        ownsProcess: true,
        commandArgs: [],
        sessionTokenPresent: true,
        gatewayWsRelayActive: false,
      },
    };

    const html = renderHealthGrid();
    const homeItem = healthItemHtml(html, "Hermes Home");

    expect(homeItem).toContain("C:\\Users\\test\\.hermes");
    expect(homeItem).toContain("数据目录已识别");
    expect(homeItem).not.toContain("正在读取数据目录");
  });
});
