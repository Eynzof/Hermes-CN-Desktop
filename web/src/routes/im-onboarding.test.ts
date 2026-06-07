import { describe, expect, it } from "vitest";
import {
  buildImDiagnosticBundle,
  buildImDiagnosticPrompt,
  explainMessagingFailure,
} from "@/lib/im-onboarding-diagnostics";
import {
  FEISHU_GROUP_SCOPE,
  FEISHU_RECOMMENDED_SCOPES,
  FEISHU_REQUIRED_SCOPES,
  railPanels,
  sectionFromPath,
  statusText,
} from "./im-onboarding";

describe("im onboarding routing helpers", () => {
  it("maps /im to the Feishu page by default", () => {
    expect(sectionFromPath("/im")).toBe("feishu");
    expect(sectionFromPath("/im/")).toBe("feishu");
  });

  it("maps platform subroutes and rejects unrelated paths", () => {
    expect(sectionFromPath("/im/feishu")).toBe("feishu");
    expect(sectionFromPath("/im/weixin")).toBe("weixin");
    expect(sectionFromPath("/models")).toBeNull();
  });

  it("renders stable Chinese labels for QR states", () => {
    expect(statusText("confirmed")).toBe("已确认");
    expect(statusText("scanned")).toBe("已扫码");
    expect(statusText("expired")).toBe("已过期");
    expect(statusText(undefined)).toBe("待开始");
  });

  it("keeps context rail entries compact and secret-safe", () => {
    expect(railPanels("feishu").map((panel) => panel.label)).toEqual(["检查", "推荐", "诊断"]);
    expect(railPanels("weixin").map((panel) => panel.label)).toEqual(["iLink", "诊断"]);

    const visibleCopy = JSON.stringify([railPanels("feishu"), railPanels("weixin")]).toLowerCase();
    expect(visibleCopy).not.toContain("app_secret=");
    expect(visibleCopy).not.toContain("weixin_token=");
  });

  it("documents Feishu chat readiness scopes in the onboarding flow", () => {
    expect(FEISHU_REQUIRED_SCOPES).toEqual([
      "im:message.p2p_msg:readonly",
      "im:message:send_as_bot",
    ]);
    expect(FEISHU_REQUIRED_SCOPES).not.toContain(FEISHU_GROUP_SCOPE);
    expect(FEISHU_GROUP_SCOPE).toBe("im:message.group_at_msg:readonly");
    expect(FEISHU_RECOMMENDED_SCOPES).toContain("im:resource");

    const feishuRailCopy = JSON.stringify(railPanels("feishu"));
    expect(feishuRailCopy).toContain("im.message.receive_v1");
    expect(feishuRailCopy).toContain(FEISHU_GROUP_SCOPE);
    expect(feishuRailCopy).toContain("创建版本并发布");
  });

  it("maps platform failures to beginner-friendly next steps", () => {
    expect(explainMessagingFailure("feishu", "403 permission denied")?.title).toContain("权限");
    expect(explainMessagingFailure("feishu", "event subscription missing")?.nextStep).toContain("im.message.receive_v1");
    expect(explainMessagingFailure("weixin", "ImportError: No module named aiohttp")?.title).toContain("依赖");
    expect(explainMessagingFailure("weixin", "QR code expired")?.nextStep).toContain("重新生成二维码");
  });

  it("builds a secret-safe diagnostic prompt for Hermes Agent", () => {
    const bundle = buildImDiagnosticBundle({
      platform: "weixin",
      currentProfile: "default",
      configured: {
        WEIXIN_ACCOUNT_ID: { isSet: true, redactedValue: "wxid…demo" },
        WEIXIN_TOKEN: { isSet: true, redactedValue: "raw-token-that-should-not-leak" },
        WEIXIN_DM_POLICY: { isSet: true, redactedValue: "allowlist" },
      },
      statusData: {
        version: "dev",
        release_date: "today",
        gateway_running: false,
        gateway_pid: null,
        gateway_health_url: null,
        gateway_state: "stopped",
        gateway_platforms: {
          weixin: {
            state: "gateway_stopped",
            error_code: null,
            error_message: "gateway stopped",
            updated_at: null,
          },
        },
        gateway_exit_reason: "port already in use",
        gateway_updated_at: null,
        active_sessions: 0,
      },
      testResult: {
        ok: false,
        state: "gateway_stopped",
        message: "gateway stopped",
      },
    });
    const prompt = buildImDiagnosticPrompt(bundle);

    expect(prompt).toContain("消息平台接入排障助手");
    expect(prompt).toContain("接收服务未运行");
    expect(prompt).not.toContain("raw-token-that-should-not-leak");
    expect(JSON.stringify(bundle)).toContain("已设置（已隐藏）");
  });

  it("does not classify a successful WeChat Official Account check as an account failure", () => {
    const bundle = buildImDiagnosticBundle({
      platform: "weixin",
      currentProfile: "default",
      configured: {
        WEIXIN_ACCOUNT_ID: { isSet: true, redactedValue: "9c5fd2…im.bot" },
        WEIXIN_TOKEN: { isSet: true, redactedValue: "••••6a21" },
        WEIXIN_DM_POLICY: { isSet: true, redactedValue: "open" },
        WEIXIN_ALLOW_ALL_USERS: { isSet: true, redactedValue: "true" },
      },
      statusData: {
        version: "dev",
        release_date: "today",
        gateway_running: true,
        gateway_pid: 123,
        gateway_health_url: null,
        gateway_state: "running",
        gateway_platforms: {
          weixin: {
            state: "connected",
            error_code: null,
            error_message: null,
            updated_at: "today",
          },
        },
        gateway_exit_reason: null,
        gateway_updated_at: "today",
        active_sessions: 0,
      },
      platformInfo: {
        id: "weixin",
        name: "WeChat (Official Account)",
        description: "Connect WeChat.",
        docs_url: "",
        enabled: true,
        configured: true,
        gateway_running: true,
        state: "connected",
        error_code: null,
        error_message: "stale token warning should be ignored once connected",
        updated_at: "today",
        home_channel: null,
        env_vars: [],
      },
      testResult: {
        ok: true,
        state: "connected",
        message: "WeChat (Official Account) is connected.",
      },
    });

    expect(bundle.issues).toEqual([
      expect.objectContaining({
        level: "ok",
        title: "暂未发现明显阻断点",
      }),
    ]);
    expect(JSON.stringify(bundle.issues)).not.toContain("微信账号或口令不可用");
  });
});
