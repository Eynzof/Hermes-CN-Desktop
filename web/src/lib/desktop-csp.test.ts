import { describe, expect, it } from "vitest";
import tauriConfig from "../../../tauri.conf.json";

describe("desktop media CSP", () => {
  it("allows HTTPS video sources accepted by the message renderer", () => {
    const csp = tauriConfig.app.security.csp;
    const mediaDirective = csp.split(";").find((directive) => directive.trim().startsWith("media-src"));

    expect(mediaDirective?.trim().split(/\s+/)).toContain("https:");
  });

  it("allows the IPv6 loopback video stream accepted by the transport", () => {
    const csp = tauriConfig.app.security.csp;
    const mediaDirective = csp.split(";").find((directive) => directive.trim().startsWith("media-src"));

    expect(mediaDirective?.trim().split(/\s+/)).toContain("http://[::1]:*");
  });
});
