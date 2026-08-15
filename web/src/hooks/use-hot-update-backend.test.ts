import { describe, expect, it } from "vitest";
import { appendHotUpdateProgress } from "./use-hot-update-backend";
import type { HotUpdateProgressPayload } from "@hermes/protocol";

function line(phase: string, message: string): HotUpdateProgressPayload {
  return { phase, message };
}

describe("appendHotUpdateProgress", () => {
  it("appends to an empty progress list", () => {
    const next = appendHotUpdateProgress(undefined, line("git", "pulling origin"));
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ phase: "git", message: "pulling origin" });
  });

  it("caps the log at 200 lines, dropping the oldest", () => {
    let progress: Array<{ phase: string; percent?: number; message: string }> = [];
    for (let i = 0; i < 250; i += 1) {
      progress = appendHotUpdateProgress(progress, line("install", `step ${i}`));
    }
    expect(progress).toHaveLength(200);
    expect(progress[0].message).toBe("step 50");
    expect(progress[199].message).toBe("step 249");
  });

  it("keeps hot-update lines percent-free", () => {
    const next = appendHotUpdateProgress([], line("install", "creating venv"));
    expect("percent" in next[0]).toBe(false);
  });
});
