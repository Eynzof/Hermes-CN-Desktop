import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchExternalJSON } from "./transport";
import {
  buildAnthropicMessagesUrl,
  buildChatCompletionsUrl,
  buildGeminiGenerateContentUrl,
  probeAnthropicMessagesProvider,
  probeChatCompletionsProvider,
  probeGeminiProvider,
  probeErrorKind,
  statusCodeFromErrorMessage,
} from "./provider-probe";

vi.mock("./transport", () => ({
  fetchExternalJSON: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchExternalJSON);

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("probe url builders", () => {
  it("builds chat/completions urls", () => {
    expect(buildChatCompletionsUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("builds anthropic /v1/messages urls without doubling /v1", () => {
    expect(buildAnthropicMessagesUrl("https://www.packyapi.com")).toBe(
      "https://www.packyapi.com/v1/messages",
    );
    expect(buildAnthropicMessagesUrl("https://relay.example/v1")).toBe(
      "https://relay.example/v1/messages",
    );
  });

  it("builds native Gemini generateContent urls", () => {
    expect(buildGeminiGenerateContentUrl(
      "https://generativelanguage.googleapis.com/v1beta/",
      "gemini-3.5-flash",
    )).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    );
  });
});

describe("probe error classification", () => {
  it("extracts http status codes from error messages", () => {
    expect(statusCodeFromErrorMessage("Request failed: HTTP 401 Unauthorized")).toBe(401);
    expect(statusCodeFromErrorMessage("boom")).toBeNull();
  });

  it("classifies auth / timeout / http / network", () => {
    expect(probeErrorKind(401, "HTTP 401")).toBe("auth");
    expect(probeErrorKind(null, "request timed out")).toBe("timeout");
    expect(probeErrorKind(500, "HTTP 500")).toBe("http");
    expect(probeErrorKind(null, "Failed to fetch")).toBe("network");
    expect(probeErrorKind(null, "???")).toBe("unknown");
  });
});

describe("probeChatCompletionsProvider", () => {
  it("POSTs a 1-token request with bearer auth", async () => {
    mockedFetch.mockResolvedValueOnce({});
    const result = await probeChatCompletionsProvider({
      apiKey: "sk-x",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-5.5",
    });

    expect(result.ok).toBe(true);
    expect(result.sample_models).toEqual(["gpt-5.5"]);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-x");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-5.5", max_tokens: 1 });
  });

  it("requires base_url and model without firing a request", async () => {
    const result = await probeChatCompletionsProvider({ apiKey: "k", baseUrl: "", model: "m" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("base_url");
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("probeGeminiProvider", () => {
  it("POSTs native generateContent with x-goog-api-key", async () => {
    mockedFetch.mockResolvedValueOnce({});
    const result = await probeGeminiProvider({
      apiKey: "google-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-3.5-flash",
    });

    expect(result.ok).toBe(true);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("google-key");
    expect(headers["Authorization"]).toBeUndefined();
    expect(JSON.parse(String(init?.body))).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1 },
    });
  });
});

describe("probeAnthropicMessagesProvider", () => {
  it("POSTs /v1/messages with x-api-key + anthropic-version, no bearer", async () => {
    mockedFetch.mockResolvedValueOnce({});
    const result = await probeAnthropicMessagesProvider({
      apiKey: "sk-relay",
      baseUrl: "https://www.packyapi.com",
      model: "claude-sonnet-5",
    });

    expect(result.ok).toBe(true);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe("https://www.packyapi.com/v1/messages");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-relay");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Authorization"]).toBeUndefined();
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 1,
    });
  });

  it("maps a rejected key to an auth error", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("HTTP 401 invalid x-api-key"));
    const result = await probeAnthropicMessagesProvider({
      apiKey: "bad",
      baseUrl: "https://www.packyapi.com",
      model: "claude-sonnet-5",
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(401);
    expect(result.error_kind).toBe("auth");
  });
});
