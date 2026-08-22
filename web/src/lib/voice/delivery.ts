/**
 * TTS / Voice Messages — delivery profiles and artifact packing.
 *
 * Mirrors Python `_PLATFORM_AUDIO_DEFAULTS` and `OPUS_VOICE_PLATFORMS`.
 */

export type VoicePlatform = "telegram" | "discord" | "whatsapp" | "matrix" | "feishu" | "signal" | "default";

export interface DeliveryProfile {
  maxBytes: number;
  /** Bytes cap multiplied by safety_ratio before we consider the payload too large. */
  safetyRatio: number;
  /** Preferred output container: opus/ogg for native voice bubbles, mp3 otherwise. */
  preferredFormat: "opus" | "mp3";
  voiceCompatible: boolean;
}

export const OPUS_VOICE_PLATFORMS = new Set<VoicePlatform>([
  "telegram",
  "matrix",
  "feishu",
  "whatsapp",
  "signal",
]);

export const PLATFORM_AUDIO_DEFAULTS: Record<VoicePlatform, DeliveryProfile> = {
  telegram: { maxBytes: 50 * 1024 * 1024, safetyRatio: 0.85, preferredFormat: "opus", voiceCompatible: true },
  discord: { maxBytes: 10 * 1024 * 1024, safetyRatio: 0.85, preferredFormat: "opus", voiceCompatible: true },
  whatsapp: { maxBytes: 16 * 1024 * 1024, safetyRatio: 0.85, preferredFormat: "mp3", voiceCompatible: false },
  matrix: { maxBytes: 10 * 1024 * 1024, safetyRatio: 0.85, preferredFormat: "opus", voiceCompatible: true },
  feishu: { maxBytes: 10 * 1024 * 1024, safetyRatio: 0.85, preferredFormat: "opus", voiceCompatible: true },
  signal: { maxBytes: 10 * 1024 * 1024, safetyRatio: 0.85, preferredFormat: "opus", voiceCompatible: true },
  default: { maxBytes: 10 * 1024 * 1024, safetyRatio: 0.85, preferredFormat: "mp3", voiceCompatible: false },
};

export function deliveryProfile(platform: VoicePlatform): DeliveryProfile {
  return PLATFORM_AUDIO_DEFAULTS[platform] || PLATFORM_AUDIO_DEFAULTS.default;
}

export function effectiveByteCap(platform: VoicePlatform): number {
  const profile = deliveryProfile(platform);
  return Math.floor(profile.maxBytes * profile.safetyRatio);
}

export function chooseDeliveryFormat(platform: VoicePlatform): "opus" | "mp3" {
  return deliveryProfile(platform).preferredFormat;
}
