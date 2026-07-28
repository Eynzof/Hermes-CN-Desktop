import { beforeEach, describe, expect, it, vi } from "vitest";
import { putJSON } from "@/lib/transport";
import { MemoryProvidersResponse } from "@hermes/protocol";
import {
  memoryProviderConfigPayload,
  memoryProviderConfigQueryKey,
  memoryProviderStatusQueryKey,
  saveMemoryProviderConfig,
  toMemoryProvidersState,
} from "./use-memory";

vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn(),
  postJSON: vi.fn(),
  putJSON: vi.fn(),
  raceAbort: vi.fn(),
}));

const mockPutJSON = vi.mocked(putJSON);

describe("memory provider hooks contract", () => {
  beforeEach(() => {
    mockPutJSON.mockReset();
    mockPutJSON.mockResolvedValue({ ok: true, active: "" });
  });

  it("only exposes OpenViking and Hindsight even when Core reports legacy providers", () => {
    const response = MemoryProvidersResponse.parse({
      active: "hindsight",
      providers: [
        { name: "honcho", description: "Honcho", available: true },
        { name: "openviking", description: "OpenViking", available: true, configured: true },
        { name: "mem0", description: "Mem0", available: true },
        { name: "hindsight", description: "Hindsight", available: false, configured: true },
      ],
      builtin_files: {},
    });

    const result = toMemoryProvidersState(response);

    expect(result.active).toBe("hindsight");
    expect(result.options.map((provider) => provider.name)).toEqual(["openviking", "hindsight"]);
    expect(result.options[0].configured).toBe(true);
    expect(result.options[1].available).toBe(false);
  });

  it("keeps both supported cards visible against an older partial Core response", () => {
    const result = toMemoryProvidersState(MemoryProvidersResponse.parse({
      active: "",
      providers: [{ name: "openviking", available: true }],
    }));

    expect(result.options.map((provider) => provider.name)).toEqual(["openviking", "hindsight"]);
    expect(result.options[1].available).toBe(false);
  });

  it("saves provider config with activate false", async () => {
    const values = { endpoint: "http://127.0.0.1:1933", agent: "hermes" };

    await saveMemoryProviderConfig("openviking", values);

    expect(memoryProviderConfigPayload(values)).toEqual({ values, activate: false });
    expect(mockPutJSON).toHaveBeenCalledWith(
      "/api/memory/providers/openviking/config",
      { values, activate: false },
      expect.anything(),
    );
  });

  it("scopes config and status query keys by profile", () => {
    expect(memoryProviderConfigQueryKey("default", "openviking"))
      .not.toEqual(memoryProviderConfigQueryKey("work", "openviking"));
    expect(memoryProviderStatusQueryKey("default", "hindsight"))
      .not.toEqual(memoryProviderStatusQueryKey("work", "hindsight"));
  });
});
