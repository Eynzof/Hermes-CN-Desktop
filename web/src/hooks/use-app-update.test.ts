import { describe, expect, it } from "vitest";
import { appendAppUpdateProgress, type AppUpdateProgressLine } from "./use-app-update";
import type { AppUpdateProgressPayload } from "@hermes/protocol";

function line(percent: number, phase = "download-runtime"): AppUpdateProgressPayload {
  return { phase, percent, message: `step ${percent}` };
}

describe("appendAppUpdateProgress", () => {
  it("appends to an empty progress list", () => {
    const next = appendAppUpdateProgress({ active: true, mode: "app-update" }, line(8));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ phase: "download-runtime", percent: 8 });
  });

  it("appends in order, keeping the log capped at 200 lines", () => {
    let state = { active: true, mode: "app-update" as const, progress: [] as AppUpdateProgressLine[] };
    for (let i = 0; i < 250; i += 1) {
      state = { ...state, progress: appendAppUpdateProgress(state, line(i)) };
    }
    expect(state.progress).toHaveLength(200);
    expect(state.progress[0].percent).toBe(50);
    expect(state.progress[199].percent).toBe(249);
  });

  it("returns a fresh array without mutating the input", () => {
    const input = { active: true, mode: "app-update" as const, progress: [line(1)] };
    const next = appendAppUpdateProgress(input, line(2));
    expect(next).toHaveLength(2);
    expect(input.progress).toHaveLength(1);
  });
});
