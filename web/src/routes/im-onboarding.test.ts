import { describe, expect, it } from "vitest";
import {
  buildImDiagnosticBundle,
  buildImDiagnosticPrompt,
  explainMessagingFailure,
} from "@/lib/im-onboarding-diagnostics";
import {
  FEISHU_RECEIVE_EVENT,
  FEISHU_REQUIRED_SCOPES,
  defaultSettings,
  sectionFromPath,
  shouldShowFeishuRecovery,
  statusText,
} from "./im-onboarding";

describe("im onboarding routing helpers", () => {
  it("maps /assistant to the two-platform assistant hub", () => {
    expect(sectionFromPath("/assistant")).toBe("overview");
    expect(sectionFromPath("/assistant/")).toBe("overview");
    expect(sectionFromPath("/im")).toBe("overview");
    expect(sectionFromPath("/im/")).toBe("overview");
  });

  it("maps platform subroutes and rejects unrelated paths", () => {
    expect(sectionFromPath("/assistant/feishu")).toBe("feishu");
    expect(sectionFromPath("/assistant/weixin")).toBe("weixin");
    expect(sectionFromPath("/im/feishu")).toBe("feishu");
    expect(sectionFromPath("/im/weixin")).toBe("weixin");
    expect(sectionFromPath("/models")).toBeNull();
  });

  it("renders stable Chinese labels for QR states", () => {
    expect(statusText("confirmed")).toBe("已确认");
    expect(statusText("scanned")).toBe("已扫码，请在手机上确认");
    expect(statusText("expired")).toBe("二维码已过期");
    expect(statusText(undefined)).toBe("待开始");
  });

  it("keeps the compact Feishu recovery requirements stable", () => {
    expect(FEISHU_REQUIRED_SCOPES).toEqual([
      "im:message.p2p_msg:readonly",
      "im:message:send_as_bot",
    ]);
    expect(FEISHU_RECEIVE_EVENT).toBe("im.message.receive_v1");
  });

  it("opens all Feishu DMs without exposing access settings", () => {
    expect(defaultSettings("feishu", false)).toMatchObject({
      FEISHU_CONNECTION_MODE: "websocket",
      FEISHU_ALLOW_ALL_USERS: "true",
      FEISHU_GROUP_POLICY: "disabled",
    });
  });

  it("shows Feishu console recovery only after a failed connection check", () => {
    expect(shouldShowFeishuRecovery("feishu", undefined)).toBe(false);
    expect(shouldShowFeishuRecovery("feishu", {
      ok: true,
      state: "connected",
      message: "connected",
    })).toBe(false);
    expect(shouldShowFeishuRecovery("feishu", {
      ok: false,
      state: "error",
      message: "permission denied",
    })).toBe(true);
    expect(shouldShowFeishuRecovery("weixin", {
      ok: false,
      state: "error",
      message: "permission denied",
    })).toBe(false);
  });

  it("limits Weixin to the scanned account by default", () => {
    expect(defaultSettings("weixin", true)).toMatchObject({
      WEIXIN_DM_POLICY: "allowlist",
      WEIXIN_ALLOW_ALL_USERS: "false",
      WEIXIN_ALLOWED_USERS: "__HERMES_SCANNED_WEIXIN_USER_ID__",
    });
  });

  it("maps platform failures to beginner-friendly next steps", () => {
    expect(explainMessagingFailure("feishu", "403 permission denied")?.title).toContain("权限");
    expect(explainMessagingFailure("feishu", "event subscription missing")?.nextStep).toContain("im.message.receive_v1");
    expect(explainMessagingFailure("weixin", "ImportError: No module named aiohttp")?.title).toContain("组件");
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
    expect(prompt).toContain("网关未运行");
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
        title: "暂未发现明显问题",
      }),
    ]);
    expect(JSON.stringify(bundle.issues)).not.toContain("微信账号或口令不可用");
  });
});
