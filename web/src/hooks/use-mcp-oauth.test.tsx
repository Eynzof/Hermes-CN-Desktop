// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
const { deleteJSON, postJSON } = vi.hoisted(() => ({ deleteJSON: vi.fn(), postJSON: vi.fn() }));
vi.mock("@/lib/transport", () => ({ deleteJSON, postJSON, fetchJSON: vi.fn() }));
vi.mock("@/lib/external-links", () => ({ openExternalUrl: vi.fn() }));
vi.mock("./use-mcp", () => ({ reloadMcp: vi.fn() }));
import { useMcpOAuth } from "./use-mcp-oauth";
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

describe("MCP cancellation", () => {
  it.each([false, true])("keeps retry disabled until cleanup is acknowledged (pending start: %s)", async pendingStart => {
    const start = deferred<{ flow_id: string; status: string }>();
    const cleanup = deferred<{ ok: boolean }>();
    postJSON.mockReturnValue(start.promise);
    deleteJSON.mockReturnValue(cleanup.promise);
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, unmount } = renderHook(() => useMcpOAuth("reports"), { wrapper });
    let authorizing!: Promise<boolean>;
    await act(async () => { authorizing = result.current.authorize(); });
    if (!pendingStart) await act(async () => { start.resolve({ flow_id: "flow-one", status: "authorization_required" }); });
    let cancelling!: Promise<void>;
    await act(async () => { cancelling = result.current.cancel(); });
    expect(result.current.busy).toBe(true);
    expect(result.current.message).toBe("正在取消授权…");
    if (pendingStart) await act(async () => { start.resolve({ flow_id: "flow-one", status: "authorization_required" }); });
    expect(deleteJSON).toHaveBeenCalledWith("/api/mcp/oauth/flows/flow-one");
    expect(result.current.busy).toBe(true);
    await act(async () => { cleanup.resolve({ ok: true }); await cancelling; });
    expect(result.current.busy).toBe(false);
    expect(result.current.message).toBe("授权已取消");
    await authorizing;
    unmount();
  });
});
