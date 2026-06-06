import { describe, expect, it } from "vitest";
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
});
