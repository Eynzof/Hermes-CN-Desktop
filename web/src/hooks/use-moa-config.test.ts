// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MoaConfigResponse } from "@hermes/protocol";
import { useMoaConfig, useSaveMoaConfig } from "./use-moa-config";

const { fetchJSONMock, putJSONMock, invalidateModelOptionsCacheMock, profileState } = vi.hoisted(() => ({
  fetchJSONMock: vi.fn(),
  putJSONMock: vi.fn(),
  invalidateModelOptionsCacheMock: vi.fn(),
  profileState: { name: "default" },
}));

vi.mock("@/lib/transport", () => ({
  fetchJSON: fetchJSONMock,
  putJSON: putJSONMock,
}));
vi.mock("@/lib/model-options-cache", () => ({
  invalidateModelOptionsCache: invalidateModelOptionsCacheMock,
}));
vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => profileState.name,
}));

const PRESET = {
  id: "research",
  label: "Research MoA",
  model: "qwen3",
  temperature: 0.6,
  max_tokens: 2048,
  reference_models: ["deepseek-v3"],
  aggregator: "qwen3",
  enabled: true,
} as never;

const config: MoaConfigResponse = {
  default_preset: "research",
  active_preset: "research",
  presets: { research: PRESET },
} as never;

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("useMoaConfig", () => {
  beforeEach(() => {
    fetchJSONMock.mockReset();
    putJSONMock.mockReset();
    invalidateModelOptionsCacheMock.mockReset();
    profileState.name = "default";
    fetchJSONMock.mockResolvedValue(config);
  });

  it("fetches the MoA config from the REST endpoint with a profile-scoped key", async () => {
    const client = makeClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client, children });
    const { result } = renderHook(() => useMoaConfig(), { wrapper });

    await waitFor(() => expect(fetchJSONMock).toHaveBeenCalledTimes(1));
    expect(fetchJSONMock).toHaveBeenCalledWith(
      "/api/model/moa",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      MoaConfigResponse,
    );
    await waitFor(() => expect(result.current.data).toEqual(config));
  });

  it("scopes the query key to the active profile name", async () => {
    profileState.name = "research-team";
    const client = makeClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client, children });
    const { result } = renderHook(() => useMoaConfig(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(["moa-config", "research-team"])).toEqual(config);
    expect(client.getQueryData(["moa-config", "default"])).toBeUndefined();
  });

  it("surfaces the fetch error on the query", async () => {
    fetchJSONMock.mockRejectedValue(new Error("HTTP 404"));
    const client = makeClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client, children });
    const { result } = renderHook(() => useMoaConfig(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 });
    expect(result.current.error).toBeInstanceOf(Error);
  });
});

describe("useSaveMoaConfig", () => {
  beforeEach(() => {
    fetchJSONMock.mockReset();
    putJSONMock.mockReset();
    invalidateModelOptionsCacheMock.mockReset();
    profileState.name = "default";
    fetchJSONMock.mockResolvedValue(config);
    putJSONMock.mockImplementation(async (_path: string, body: unknown) => body);
  });

  it("PUTs the config and refreshes caches + query data on success", async () => {
    const client = makeClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client, children });
    const { result } = renderHook(
      () => ({ query: useMoaConfig(), save: useSaveMoaConfig() }),
      { wrapper },
    );

    await waitFor(() => expect(fetchJSONMock).toHaveBeenCalledTimes(1));

    const updated = { ...config, default_preset: "coding" } as MoaConfigResponse;
    act(() => {
      result.current.save.mutate(updated);
    });

    await waitFor(() => expect(putJSONMock).toHaveBeenCalledWith("/api/model/moa", updated, MoaConfigResponse));
    expect(invalidateModelOptionsCacheMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(client.getQueryData(["moa-config", "default"])).toEqual(updated));
  });

  it("exposes mutation state for the UI", async () => {
    const client = makeClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client, children });
    const { result } = renderHook(() => useSaveMoaConfig(), { wrapper });

    expect(result.current.isIdle).toBe(true);
    act(() => {
      result.current.mutate(config);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
