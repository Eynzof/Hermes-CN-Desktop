import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PROVIDER_CATALOG, buildProviderConfigUpdate } from "./provider-catalog";
import { probeAnthropicMessagesProvider, probeChatCompletionsProvider } from "./provider-probe";

// Keep the production serializer and transport; intercept only the HTTP boundary.
afterEach(() => vi.unstubAllGlobals());

describe("MiniMax probe HTTP boundary", () => {
  const preset = BUILTIN_PROVIDER_CATALOG.providers.find((entry) => entry.id === "minimax-cn")!;
  it("sends the new preset default through the desktop external-request bridge", async () => {
    const externalRequest = vi.fn(async () => ({ ok: true, status: 200, body: "{}" }));
    vi.stubGlobal("window", { hermesDesktop: { externalRequest } });
    const config = buildProviderConfigUpdate({}, preset, { apiKey: "fixture-key", baseUrl: "", model: "" });
    const result = await probeAnthropicMessagesProvider({
      apiKey: config.model.api_key, baseUrl: config.model.base_url, model: config.model.default,
    });
    expect(result.ok).toBe(true);
    expect(externalRequest).toHaveBeenCalledWith({
      path: "https://api.minimaxi.com/anthropic/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json",
        "x-api-key": "fixture-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "MiniMax-M3.1-Flash", max_tokens: 1,
        messages: [{ role: "user", content: "ping" }] }),
    });
  });

  it.each(["https://api.minimax.io", "https://api.minimaxi.com"])(
    "preserves selected IDs over both existing protocols at %s", async (origin) => {
      vi.stubGlobal("window", {});
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      for (const model of ["MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7", "custom-model"]) {
        for (const anthropic of [true, false]) {
          const probe = anthropic ? probeAnthropicMessagesProvider : probeChatCompletionsProvider;
          await probe({ apiKey: "fixture-key", baseUrl: `${origin}/${anthropic ? "anthropic" : "v1"}`, model });
          const [url, init] = vi.mocked(fetch).mock.calls.at(-1)!;
          expect(url).toBe(`${origin}/${anthropic ? "anthropic/v1/messages" : "v1/chat/completions"}`);
          expect(init?.method).toBe("POST");
          const body = JSON.parse(String(init?.body));
          expect(body).toEqual({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }],
            ...(anthropic ? {} : { stream: false }) });
          expect(body).not.toHaveProperty("service_tier");
          expect(body).not.toHaveProperty("thinking");
          expect(body).not.toHaveProperty("reasoning_effort");
        }
      }
    },
  );
});
