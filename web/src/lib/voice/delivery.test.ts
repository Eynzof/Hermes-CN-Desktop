import { describe, expect, it } from "vitest";
import { chooseDeliveryFormat, deliveryProfile, effectiveByteCap, OPUS_VOICE_PLATFORMS } from "./delivery";

describe("delivery profiles", () => {
  it("telegram uses opus and is voice compatible", () => {
    const profile = deliveryProfile("telegram");
    expect(profile.preferredFormat).toBe("opus");
    expect(profile.voiceCompatible).toBe(true);
    expect(OPUS_VOICE_PLATFORMS.has("telegram")).toBe(true);
  });

  it("discord has 10MB cap", () => {
    expect(deliveryProfile("discord").maxBytes).toBe(10 * 1024 * 1024);
  });

  it("effective byte cap applies safety ratio", () => {
    expect(effectiveByteCap("telegram")).toBe(Math.floor(50 * 1024 * 1024 * 0.85));
  });

  it("whatsapp uses mp3", () => {
    expect(chooseDeliveryFormat("whatsapp")).toBe("mp3");
  });

  it("unknown platform falls back to default", () => {
    const profile = deliveryProfile("unknown" as never);
    expect(profile.preferredFormat).toBe("mp3");
  });
});
