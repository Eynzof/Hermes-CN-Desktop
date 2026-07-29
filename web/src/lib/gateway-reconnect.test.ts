import { describe, it, expect, vi } from "vitest";
import {
  isDefinitiveMissingSessionError,
  reattachAfterReconnect,
  type ReattachAfterReconnectDeps,
} from "./gateway-reconnect";

function makeDeps(overrides: Partial<ReattachAfterReconnectDeps> = {}): {
  deps: ReattachAfterReconnectDeps;
  resume: ReturnType<typeof vi.fn>;
  onResumed: ReturnType<typeof vi.fn>;
  onResumeFailed: ReturnType<typeof vi.fn>;
} {
  const resume = vi.fn(async (persistentId: string) => ({ session_id: `gw-${persistentId}` }));
  const onResumed = vi.fn();
  const onResumeFailed = vi.fn();
  const deps: ReattachAfterReconnectDeps = {
    getActiveSessionId: () => "gw-old",
    resolvePersistentId: (id) => (id === "gw-old" ? "sess-1" : id),
    resume,
    onResumed,
    onResumeFailed,
    ...overrides,
  };
  return { deps, resume, onResumed, onResumeFailed };
}

describe("reattachAfterReconnect", () => {
  it("no-ops when there is no active session", async () => {
    const { deps, resume, onResumed, onResumeFailed } = makeDeps({
      getActiveSessionId: () => null,
    });
    await reattachAfterReconnect(deps);
    expect(resume).not.toHaveBeenCalled();
    expect(onResumed).not.toHaveBeenCalled();
    expect(onResumeFailed).not.toHaveBeenCalled();
  });

  it("resumes the resolved persistent id and reports the new gateway id", async () => {
    const { deps, resume, onResumed, onResumeFailed } = makeDeps();
    await reattachAfterReconnect(deps);
    expect(resume).toHaveBeenCalledWith("sess-1");
    expect(onResumed).toHaveBeenCalledWith("gw-sess-1", "sess-1");
    expect(onResumeFailed).not.toHaveBeenCalled();
  });

  it("prefers the server-reported resumed persistent id when present", async () => {
    const { deps, onResumed } = makeDeps({
      resume: vi.fn(async () => ({ session_id: "gw-new", resumed: "sess-canonical" })),
    });
    await reattachAfterReconnect(deps);
    expect(onResumed).toHaveBeenCalledWith("gw-new", "sess-canonical");
  });

  it("escalates to onResumeFailed when resume rejects (session gone)", async () => {
    const { deps, onResumed, onResumeFailed } = makeDeps({
      resume: vi.fn(async () => {
        throw new Error("Session not found");
      }),
    });
    await reattachAfterReconnect(deps);
    expect(onResumed).not.toHaveBeenCalled();
    expect(onResumeFailed).toHaveBeenCalledTimes(1);
  });

  it("escalates to onResumeFailed when resume returns no session_id", async () => {
    const { deps, onResumed, onResumeFailed } = makeDeps({
      resume: vi.fn(async () => ({ session_id: "" })),
    });
    await reattachAfterReconnect(deps);
    expect(onResumed).not.toHaveBeenCalled();
    expect(onResumeFailed).toHaveBeenCalledTimes(1);
  });
});

describe("isDefinitiveMissingSessionError", () => {
  it.each([
    new Error("Session not found"),
    new Error("unknown conversation id"),
    "conversation was reaped",
  ])("accepts explicit missing-session failures", (error) => {
    expect(isDefinitiveMissingSessionError(error)).toBe(true);
  });

  it.each([
    new Error("Request timed out after 300000ms"),
    new Error("WebSocket disconnected"),
    new Error("HTTP 503 Service Unavailable"),
  ])("keeps transient resume failures recoverable", (error) => {
    expect(isDefinitiveMissingSessionError(error)).toBe(false);
  });
});
