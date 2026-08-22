/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
  filterModelOptionsBySlugFilter,
  isCnCanonicalProvider,
  probeProviderModels,
} from "./model-options-cn";
import type { ModelOptionsResult } from "@hermes/protocol";

describe("model-options-cn", () => {
  it("detects canonical CN slugs", () => {
    expect(isCnCanonicalProvider("deepseek")).toBe(true);
    expect(isCnCanonicalProvider("lm_studio")).toBe(false);
  });

  it("filters model options by slug filter", () => {
    const result: ModelOptionsResult = {
      providers: [
        { provider: "deepseek", slug: "deepseek", models: [] } as any,
        { provider: "lm_studio", slug: "lm_studio", models: [] } as any,
        { provider: "openai-codex", slug: "openai-codex", models: [] } as any,
      ],
    };
    const filtered = filterModelOptionsBySlugFilter(result);
    expect(filtered.providers.map((p: any) => p.slug)).toEqual(["deepseek", "openai-codex"]);
  });

  it("preserves custom providers outside the canonical list", () => {
    const result: ModelOptionsResult = {
      providers: [
        { provider: "my-custom", slug: "my-custom", models: [] } as any,
      ],
    };
    const filtered = filterModelOptionsBySlugFilter(result);
    expect(filtered.providers).toHaveLength(0);
  });

  it("probes OpenAI-compatible /v1/models", async () => {
    const data = { data: [{ id: "gpt-4" }, { id: "gpt-3.5" }] };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve(data),
    } as Response);
    const result = await probeProviderModels("openai", "sk", "https://api.openai.com/v1");
    expect(result.ok).toBe(true);
    expect(result.model_count).toBe(2);
    expect(result.sample_models).toEqual(["gpt-4", "gpt-3.5"]);
  });

  it("probes anthropic_messages /v1/models with x-api-key", async () => {
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
      capturedHeaders = init?.headers;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ data: [{ id: "claude-3-opus" }] }),
      } as Response);
    });
    await probeProviderModels("anthropic", "key", "https://api.anthropic.com", "anthropic_messages");
    expect((capturedHeaders as Record<string, string>)?.["x-api-key"]).toBe("key");
  });

  it("returns structured error on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
    const result = await probeProviderModels("x", "", "https://x");
    expect(result.ok).toBe(false);
    expect(result.error_kind).toBe("network");
  });
});
