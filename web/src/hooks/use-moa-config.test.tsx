// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fetchJSON } from "@/lib/transport";
import { useMoaSource } from "./use-moa-config";

vi.mock("@/lib/transport", () => ({ fetchJSON: vi.fn(), putJSON: vi.fn() }));
vi.mock("@/hooks/use-profiles", () => ({ useActiveProfileName: () => "work" }));

function inspect() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useMoaSource(), { wrapper }).result;
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  delete window.__HERMES_RUNTIME__;
});

describe("旧配置检查的连接与档案范围", () => {
  it("远程连接即使由回环端口转发也不读取配置", () => {
    window.__HERMES_RUNTIME__ = {platform: "tauri", connectionMode: "remote", apiBaseUrl: "http://localhost:9120"};
    expect(inspect().current.fetchStatus).toBe("idle");
    expect(fetchJSON).not.toHaveBeenCalled();
  });
  it("本机运行档案不同时不读取原文件", async () => {
    window.__HERMES_RUNTIME__ = {platform: "tauri", connectionMode: "local", apiBaseUrl: "http://localhost:9119"};
    vi.mocked(fetchJSON).mockResolvedValueOnce({current: "personal", active: "work"});
    const result = inspect();
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(fetchJSON).toHaveBeenCalledTimes(1);
  });
  it("使用正在运行的档案，只缓存混合模型字段", async () => {
    window.__HERMES_RUNTIME__ = {platform: "tauri", connectionMode: "managed", apiBaseUrl: "http://localhost:9120"};
    vi.mocked(fetchJSON).mockResolvedValueOnce({current: "work"}).mockResolvedValueOnce({
      yaml: "model: {api_key: test-secret}\nmoa: {presets: {work: {}}}",
    });
    const result = inspect();
    await waitFor(() => expect(result.current.data).toEqual({kind: "named", names: ["work"]}));
    expect(fetchJSON).toHaveBeenLastCalledWith("/api/config/raw?profile=current", expect.anything());
  });
});
