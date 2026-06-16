import { beforeEach, describe, expect, it } from "vitest";
import {
  getCachedModelOptions,
  invalidateModelOptionsCache,
  MODEL_OPTIONS_CACHE_TTL_MS,
} from "./model-options-cache";

function setRuntime(input: Partial<NonNullable<Window["__HERMES_RUNTIME__"]>> = {}) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  window.__HERMES_RUNTIME__ = {
    connectionMode: "managed",
    apiBaseUrl: "http://127.0.0.1:9120",
    currentProfile: "default",
    ...input,
  };
}

describe("model options cache", () => {
  beforeEach(() => {
    invalidateModelOptionsCache();
    setRuntime();
  });

  it("deduplicates concurrent loads and returns fresh cached values", async () => {
    let calls = 0;
    let now = 1000;
    const loader = async () => {
      calls += 1;
      return { providers: [{ slug: "local", models: ["m1"] }], model: "m1" };
    };

    const [first, second] = await Promise.all([
      getCachedModelOptions(undefined, loader, () => now),
      getCachedModelOptions(undefined, loader, () => now),
    ]);
    expect(calls).toBe(1);
    expect(first).toBe(second);

    now += MODEL_OPTIONS_CACHE_TTL_MS - 1;
    const cached = await getCachedModelOptions(undefined, loader, () => now);
    expect(cached).toBe(first);
    expect(calls).toBe(1);
  });

  it("invalidates session-scoped entries independently", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { providers: [{ slug: `p${calls}` }] };
    };

    const first = await getCachedModelOptions("s1", loader);
    const second = await getCachedModelOptions("s2", loader);
    expect(first.providers[0]?.slug).toBe("p1");
    expect(second.providers[0]?.slug).toBe("p2");

    invalidateModelOptionsCache("s1");
    const refreshed = await getCachedModelOptions("s1", loader);
    const stillCached = await getCachedModelOptions("s2", loader);
    expect(refreshed.providers[0]?.slug).toBe("p3");
    expect(stillCached).toBe(second);
  });

  it("isolates entries by connection mode and backend URL", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { providers: [{ slug: `backend-${calls}` }] };
    };

    const managed = await getCachedModelOptions(undefined, loader);
    setRuntime({
      connectionMode: "local",
      apiBaseUrl: "http://127.0.0.1:9119",
      dashboardApiBaseUrl: "http://127.0.0.1:9119",
    });
    const local = await getCachedModelOptions(undefined, loader);
    setRuntime({ connectionMode: "managed", apiBaseUrl: "http://127.0.0.1:9120" });
    const managedAgain = await getCachedModelOptions(undefined, loader);

    expect(managed.providers[0]?.slug).toBe("backend-1");
    expect(local.providers[0]?.slug).toBe("backend-2");
    expect(managedAgain).toBe(managed);
  });
});
