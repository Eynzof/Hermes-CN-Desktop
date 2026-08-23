import { describe, expect, it } from "vitest";
import {
  defaultUpdateConfig,
  normalizeUpdateConfig,
  parseUpdateInvitation,
  validateUpdateConfig,
} from "./update-config";

describe("defaultUpdateConfig", () => {
  it("points at the CN landing source with stable channel", () => {
    const cfg = defaultUpdateConfig();
    expect(cfg.schemaVersion).toBe(2);
    expect(cfg.channel).toBe("stable");
    expect(cfg.shellUpdaterEndpoint).toBe("");
    expect(cfg.releaseManifestUrl).toBe("https://desktop.hermesagent.org.cn/latest.json");
    expect(cfg.runtimeBaseUrl).toBe("https://desktop.hermesagent.org.cn/runtime");
    expect(cfg.timeoutSeconds).toBe(10);
    expect(cfg.verifySha256).toBe(true);
    expect(cfg.verifySignature).toBe(true);
  });
});

describe("normalizeUpdateConfig", () => {
  it("returns defaults for garbage input", () => {
    expect(normalizeUpdateConfig(null)).toEqual(defaultUpdateConfig());
    expect(normalizeUpdateConfig("nope")).toEqual(defaultUpdateConfig());
  });

  it("fills missing fields from defaults", () => {
    const cfg = normalizeUpdateConfig({ channel: "beta" });
    expect(cfg.channel).toBe("beta");
    expect(cfg.releaseManifestUrl).toBe(defaultUpdateConfig().releaseManifestUrl);
    expect(cfg.mirrors).toEqual([]);
  });
});

describe("parseUpdateInvitation", () => {
  it("accepts a restricted-ring invitation", () => {
    expect(parseUpdateInvitation(JSON.stringify({
      schemaVersion: 1,
      endpoint: "https://hot-update-staging.hermesagent.org.cn/v1/check/{{channel}}/{{target}}/{{arch}}/{{current_version}}",
      channel: "prototype",
      deviceId: "primelab-win",
      token: "one-time-secret",
    }))).toMatchObject({ channel: "prototype", deviceId: "primelab-win" });
  });

  it("rejects stable invitations", () => {
    expect(() => parseUpdateInvitation(JSON.stringify({
      schemaVersion: 1,
      endpoint: "https://staging.example/v1/check/x",
      channel: "stable",
      deviceId: "device",
      token: "secret",
    }))).toThrow(/channel/);
  });
});

describe("validateUpdateConfig", () => {
  it("accepts a valid config", () => {
    expect(validateUpdateConfig(defaultUpdateConfig())).toBeNull();
  });

  it("rejects unknown channels", () => {
    const cfg = defaultUpdateConfig();
    cfg.channel = "nightly";
    expect(validateUpdateConfig(cfg)).toContain("channel");
  });

  it("rejects http URLs", () => {
    const cfg = defaultUpdateConfig();
    cfg.shellUpdaterEndpoint = "http://insecure.example/check";
    expect(validateUpdateConfig(cfg)).toContain("https");
  });

  it("rejects an external HTTPS updater control host", () => {
    const cfg = defaultUpdateConfig();
    cfg.shellUpdaterEndpoint = "https://evil.example/v1/check/{{channel}}/{{target}}/{{arch}}/{{current_version}}";
    expect(validateUpdateConfig(cfg)).toContain("Hermes Cloudflare");
  });

  it("rejects out-of-range timeouts", () => {
    const cfg = defaultUpdateConfig();
    cfg.timeoutSeconds = 9999;
    expect(validateUpdateConfig(cfg)).toContain("timeoutSeconds");
  });
});
