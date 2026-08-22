import type { PortalStatusResponse } from "./types.js";

export function getNousPortalAccountInfo(): PortalStatusResponse {
  return {
    loggedIn: false,
    portalUrl: "https://portal.nousresearch.com",
    inferenceUrl: "https://api.nousresearch.com",
    provider: "nous",
    subscriptionUrl: "https://portal.nousresearch.com/billing",
    features: [
      { key: "web", label: "Web search", available: true, active: false, managedByNous: false },
      { key: "image_gen", label: "Image generation", available: true, active: false, managedByNous: false },
      { key: "tts", label: "Text to speech", available: true, active: false, managedByNous: false },
      { key: "browser", label: "Browser automation", available: true, active: false, managedByNous: false },
    ],
  };
}
