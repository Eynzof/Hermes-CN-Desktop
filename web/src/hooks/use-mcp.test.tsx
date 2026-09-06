// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteJSON } = vi.hoisted(() => ({
  deleteJSON: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/transport", () => ({
  deleteJSON,
  fetchJSON: vi.fn(),
  postJSON: vi.fn(),
  putJSON: vi.fn(),
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => "e2e-director",
}));

import { useRemoveMcpServer } from "./use-mcp";

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useRemoveMcpServer", () => {
  beforeEach(() => deleteJSON.mockClear());

  it("refreshes both installed servers and catalog installation state", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRemoveMcpServer(), {
      wrapper: wrapperFor(client),
    });

    await act(async () => {
      await result.current.mutateAsync("unreal-engine");
    });

    expect(deleteJSON).toHaveBeenCalledWith(
      "/api/mcp/servers/unreal-engine",
      undefined,
      expect.anything(),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["mcp-servers-full"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["mcp-catalog"] });
  });
});
