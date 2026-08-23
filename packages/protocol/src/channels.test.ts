import { describe, expect, it } from "vitest";
import { CHANNEL_PREFIX, Channels, type ChannelName } from "./channels";

describe("CHANNEL_PREFIX", () => {
  it("is the fixed desktop prefix", () => {
    expect(CHANNEL_PREFIX).toBe("hermes_desktop");
  });
});

describe("Channels", () => {
  it("prefixes every channel with the desktop prefix", () => {
    for (const name of Object.values(Channels)) {
      expect(name.startsWith(`${CHANNEL_PREFIX}:`)).toBe(true);
    }
  });

  it("maps canonical Tauri command names", () => {
    expect(Channels.apiRequest).toBe("hermes_desktop:api-request");
    expect(Channels.externalRequest).toBe("hermes_desktop:external-request");
    expect(Channels.getSessionToken).toBe("hermes_desktop:get-session-token");
    expect(Channels.systemResume).toBe("hermes_desktop:system-resume");
  });

  it("exposes unique channel names (no collisions)", () => {
    const values = Object.values(Channels);
    expect(new Set(values).size).toBe(values.length);
  });

  it("exposes one entry per declared key", () => {
    const keys = Object.keys(Channels);
    expect(keys.length).toBe(Object.values(Channels).length);
    expect(keys).toContain("runtimeInfo");
    expect(keys).toContain("switchProfile");
  });

  it("types ChannelName as the union of channel values", () => {
    const first: ChannelName = Channels.apiRequest;
    expect(first).toBe("hermes_desktop:api-request");
  });
});
