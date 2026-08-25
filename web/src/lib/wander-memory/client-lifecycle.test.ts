import { describe, expect, it, vi } from "vitest";
import type { WanderMemoryClient } from "./client";
import {
  __resetWanderMemoryClientForTests,
  disposeWanderMemoryClient,
  resetWanderMemoryClient,
} from "./client";

describe("Wander Memory singleton lifecycle", () => {
  it("disposes the active client and clears the singleton", () => {
    const dispose = vi.fn();
    const client = { mode: "demo", dispose } as unknown as WanderMemoryClient;
    resetWanderMemoryClient(client);

    disposeWanderMemoryClient();

    expect(dispose).toHaveBeenCalledTimes(1);
    __resetWanderMemoryClientForTests();
  });
});
