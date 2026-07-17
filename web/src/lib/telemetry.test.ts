import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchExternalJSON } from "./transport";
import {
  buildTelemetryPayload,
  isPingDue,
  PING_INTERVAL_MS,
  reportPromoClick,
  sendTelemetryPingIfDue,
  TELEMETRY_ENABLED_KEY,
} from "./telemetry";
import { writeUiValue, __resetUiStoreForTests } from "./ui-store";

vi.mock("./transport", () => ({
  fetchExternalJSON: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchExternalJSON);

beforeEach(() => {
  __resetUiStoreForTests({});
  mockedFetch.mockReset();
  mockedFetch.mockResolvedValue(null);
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
