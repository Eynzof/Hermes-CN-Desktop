/**
 * Hermes Browser Automation — TypeScript core.
 *
 * Minimal first cut:
 *   - Provider interface + registry with Core-precedence resolution
 *   - Local CDP/agent-browser backend wired through Rust IPC
 *   - Cloud provider stubs (Browserbase, Browser Use, Firecrawl, Camofox)
 *   - SSRF/URL-safety helpers
 *   - Snapshot formatting + overflow storage
 *   - Session manager
 */

export * from "./schemas.js";
export * from "./provider.js";
export * from "./registry.js";
export * from "./ssrf.js";
export * from "./snapshot.js";
export * from "./session-manager.js";
export * from "./tool-handlers.js";

export { LocalBrowserProvider } from "./backends/local.js";
export {
  BrowserbaseProvider,
  BrowserUseCloudProvider,
  FirecrawlProvider,
  CamofoxProvider,
} from "./backends/cloud.js";
