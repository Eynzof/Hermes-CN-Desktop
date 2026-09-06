// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WanderMemoryRouteLifecycle } from "./route-lifecycle";

const clientMocks = vi.hoisted(() => ({
  dispose: vi.fn(),
}));

vi.mock("@/lib/wander-memory/client", () => ({
  disposeWanderMemoryClient: clientMocks.dispose,
}));

afterEach(() => {
  cleanup();
  clientMocks.dispose.mockReset();
});

describe("WanderMemoryRouteLifecycle", () => {
  it("keeps the client across Wander routes and disposes it on group exit", async () => {
    const view = render(<WanderMemoryRouteLifecycle active />);

    view.rerender(<WanderMemoryRouteLifecycle active />);
    expect(clientMocks.dispose).not.toHaveBeenCalled();

    view.rerender(<WanderMemoryRouteLifecycle active={false} />);
    await waitFor(() => expect(clientMocks.dispose).toHaveBeenCalledTimes(1));
  });
});
