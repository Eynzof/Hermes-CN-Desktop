import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveXaiCredentials, hasXaiCredentials, setXaiCredentialsForTest } from "./credentials.js";
import type { ToolContext } from "@hermes/agent-tools";

describe("x_search credentials", () => {
  beforeEach(() => {
    setXaiCredentialsForTest(null);
  });

  it("returns null when no credentials", () => {
    expect(resolveXaiCredentials()).toBeNull();
    expect(hasXaiCredentials()).toBe(false);
  });

  it("resolves XAI_API_KEY from tool context", () => {
    const ctx: ToolContext = { env: { XAI_API_KEY: "secret", XAI_BASE_URL: "https://x.ai/v1" } };
    const creds = resolveXaiCredentials(ctx);
    expect(creds).toEqual({ bearer: "secret", source: "xai", baseUrl: "https://x.ai/v1" });
  });

  it("falls back to default base URL", () => {
    const ctx: ToolContext = { env: { XAI_API_KEY: "secret" } };
    const creds = resolveXaiCredentials(ctx);
    expect(creds?.baseUrl).toBe("https://api.x.ai/v1");
  });

  it("prefers test override", () => {
    setXaiCredentialsForTest({ bearer: "override", source: "xai-oauth", baseUrl: "https://api.x.ai/v1" });
    expect(resolveXaiCredentials()?.bearer).toBe("override");
    expect(resolveXaiCredentials()?.source).toBe("xai-oauth");
  });
});