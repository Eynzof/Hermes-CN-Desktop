import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchExternalJSON } from "./transport";
import {
  buildTokenUsageTelemetryPayload,
  buildTelemetryPayload,
  isPingDue,
  PING_INTERVAL_MS,
  reportPromoClick,
  sendTelemetryPingIfDue,
  sendTokenUsageTelemetryIfDue,
  TELEMETRY_ENABLED_KEY,
  TOKEN_USAGE_LAST_REPORTED_KEY,
} from "./telemetry";
import {
  getUiTurnStatsWindow,
  readUiValue,
  writeUiValue,
  __resetUiStoreForTests,
  type UiTurnStats,
} from "./ui-store";

vi.mock("./transport", () => ({
  fetchExternalJSON: vi.fn(),
}));

vi.mock("./ui-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui-store")>();
  return {
    ...actual,
    getUiTurnStatsWindow: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchExternalJSON);
const mockedGetTurnStatsWindow = vi.mocked(getUiTurnStatsWindow);

beforeEach(() => {
  __resetUiStoreForTests({});
  mockedFetch.mockReset();
  mockedFetch.mockResolvedValue(null);
  mockedGetTurnStatsWindow.mockReset();
  mockedGetTurnStatsWindow.mockResolvedValue([]);
});

describe("isPingDue", () => {
  it("treats missing or malformed timestamps as due", () => {
    expect(isPingDue(0, 1000)).toBe(true);
    expect(isPingDue(undefined, 1000)).toBe(true);
    expect(isPingDue("not-a-number", 1000)).toBe(true);
  });

  it("respects the 24h interval", () => {
    const last = 1_000_000;
    expect(isPingDue(last, last + PING_INTERVAL_MS - 1)).toBe(false);
    expect(isPingDue(last, last + PING_INTERVAL_MS)).toBe(true);
  });
});

describe("sendTelemetryPingIfDue", () => {
  it("sends an anonymous ping and records the timestamp", async () => {
    const sent = await sendTelemetryPingIfDue(5_000_000);
    expect(sent).toBe(true);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0]!;
    expect(url).toMatch(/\/api\/telemetry$/);
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({ event: "ping" });
    expect(payload.device_id).toBeTruthy();
    expect(payload.app_version).toBeTruthy();
    // 同一周期内不重复发送
    const again = await sendTelemetryPingIfDue(5_000_000 + 60_000);
    expect(again).toBe(false);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the user turned telemetry off", async () => {
    writeUiValue(TELEMETRY_ENABLED_KEY, false);
    expect(await sendTelemetryPingIfDue()).toBe(false);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("keeps the device id stable across pings", async () => {
    await sendTelemetryPingIfDue(1_000);
    await sendTelemetryPingIfDue(1_000 + PING_INTERVAL_MS + 1);
    const first = JSON.parse(String(mockedFetch.mock.calls[0]![1]?.body)).device_id;
    const second = JSON.parse(String(mockedFetch.mock.calls[1]![1]?.body)).device_id;
    expect(first).toBe(second);
  });
});

describe("reportPromoClick", () => {
  it("sends a promo_click event carrying the provider id", () => {
    reportPromoClick("packycode");
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(mockedFetch.mock.calls[0]![1]?.body));
    expect(payload).toMatchObject({ event: "promo_click", provider_id: "packycode" });
  });

  it("is gated by the telemetry toggle", () => {
    writeUiValue(TELEMETRY_ENABLED_KEY, false);
    reportPromoClick("packycode");
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("buildTelemetryPayload", () => {
  it("never includes fields beyond the documented allowlist", () => {
    const payload = buildTelemetryPayload("ping", "device-1");
    expect(Object.keys(payload).sort()).toEqual([
      "app_version",
      "catalog_version",
      "device_id",
      "event",
      "locale",
      "os",
    ]);
  });
});

describe("buildTokenUsageTelemetryPayload", () => {
  it("aggregates token usage by model without carrying session metadata", () => {
    const rows: UiTurnStats[] = [
      {
        id: "row-1",
        sessionId: "session-secret-1",
        model: "gpt-5",
        provider: "openai",
        tokensInput: 10,
        tokensOutput: 5,
        tokensTotal: 15,
        cacheRead: 2,
        cacheWrite: 1,
        reasoningTokens: 3,
        apiCalls: 1,
        metadata: { persistedId: "message-secret", profile: "research", content: "prompt text" },
      },
      {
        id: "row-2",
        sessionId: "session-secret-2",
        model: "gpt-5",
        provider: "openai",
        tokensInput: 4,
        tokensOutput: 6,
        tokensTotal: 10,
        apiCalls: 2,
      },
      {
        id: "row-3",
        sessionId: "session-secret-3",
        model: "anthropic/claude-sonnet-4",
        tokensInput: 8,
        tokensTotal: 12,
        cacheRead: 1,
      },
    ];

    const payload = buildTokenUsageTelemetryPayload(rows, {
      deviceId: "device-1",
      periodStartMs: 1_000,
      periodEndMs: 2_000,
    });

    expect(payload).toMatchObject({
      event: "token_usage_daily",
      device_id: "device-1",
      period_start_ms: 1_000,
      period_end_ms: 2_000,
      totals: {
        input_tokens: 22,
        output_tokens: 15,
        total_tokens: 37,
        cache_read_tokens: 3,
        cache_write_tokens: 1,
        reasoning_tokens: 3,
        api_calls: 3,
        turns: 3,
      },
    });
    expect(payload?.models).toEqual([
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5",
        input_tokens: 14,
        output_tokens: 11,
        total_tokens: 25,
        turns: 2,
      }),
      expect.objectContaining({
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4",
        input_tokens: 8,
        output_tokens: 4,
        total_tokens: 12,
        turns: 1,
      }),
    ]);
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      "app_version",
      "catalog_version",
      "device_id",
      "event",
      "locale",
      "models",
      "os",
      "period_end_ms",
      "period_start_ms",
      "totals",
    ]);
    expect(Object.keys(payload?.totals ?? {}).sort()).toEqual([
      "api_calls",
      "cache_read_tokens",
      "cache_write_tokens",
      "input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "total_tokens",
      "turns",
    ]);
    expect(Object.keys(payload?.models[0] ?? {}).sort()).toEqual([
      "api_calls",
      "cache_read_tokens",
      "cache_write_tokens",
      "input_tokens",
      "model",
      "output_tokens",
      "provider",
      "reasoning_tokens",
      "total_tokens",
      "turns",
    ]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("session-secret");
    expect(serialized).not.toContain("message-secret");
    expect(serialized).not.toContain("prompt text");
    expect(serialized).not.toContain("research");
  });

  it("returns null when there are no token totals to report", () => {
    expect(buildTokenUsageTelemetryPayload([
      { id: "row-1", sessionId: "s1", model: "gpt-5", tokensTotal: 0 },
    ], {
      deviceId: "device-1",
      periodStartMs: 1_000,
      periodEndMs: 2_000,
    })).toBeNull();
  });
});

describe("sendTokenUsageTelemetryIfDue", () => {
  it("does not read or send token usage when telemetry is disabled", async () => {
    writeUiValue(TELEMETRY_ENABLED_KEY, false);
    expect(await sendTokenUsageTelemetryIfDue(5_000_000)).toBe(false);
    expect(mockedGetTurnStatsWindow).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("sends daily token usage and records the successful report timestamp", async () => {
    const now = PING_INTERVAL_MS + 5_000_000;
    mockedGetTurnStatsWindow.mockResolvedValue([
      {
        id: "row-1",
        sessionId: "s1",
        model: "gpt-5",
        provider: "openai",
        tokensInput: 10,
        tokensOutput: 5,
        tokensTotal: 15,
        apiCalls: 1,
      },
    ]);

    const sent = await sendTokenUsageTelemetryIfDue(now);
    expect(sent).toBe(true);
    expect(mockedGetTurnStatsWindow).toHaveBeenCalledWith({ sinceMs: 5_000_000, limit: 20_000 });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(mockedFetch.mock.calls[0]![1]?.body));
    expect(payload).toMatchObject({
      event: "token_usage_daily",
      totals: { input_tokens: 10, output_tokens: 5, total_tokens: 15, api_calls: 1, turns: 1 },
      models: [{ provider: "openai", model: "gpt-5", total_tokens: 15 }],
    });
    expect(readUiValue(TOKEN_USAGE_LAST_REPORTED_KEY, 0)).toBe(now);

    expect(await sendTokenUsageTelemetryIfDue(now + 60_000)).toBe(false);
    expect(mockedGetTurnStatsWindow).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("does not send an empty token usage payload", async () => {
    mockedGetTurnStatsWindow.mockResolvedValue([
      { id: "row-1", sessionId: "s1", model: "gpt-5", tokensTotal: 0 },
    ]);

    expect(await sendTokenUsageTelemetryIfDue(5_000_000)).toBe(false);
    expect(mockedGetTurnStatsWindow).toHaveBeenCalledTimes(1);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
