import { describe, expect, it } from "vitest";
import { derivePetState } from "./state";
import type { PetActivity } from "./constants";

function activity(overrides: Partial<PetActivity> = {}): PetActivity {
  return overrides;
}

describe("derivePetState", () => {
  it("is idle when nothing is happening", () => {
    expect(derivePetState({})).toBe("idle");
    expect(derivePetState(activity())).toBe("idle");
  });

  it("shows the failed state on error, highest priority", () => {
    expect(derivePetState({ error: true })).toBe("failed");
    expect(derivePetState({ error: true, celebrate: true })).toBe("failed");
    expect(derivePetState({ error: true, awaitingInput: true, busy: true })).toBe("failed");
  });

  it("jumps on celebration", () => {
    expect(derivePetState({ celebrate: true })).toBe("jump");
    expect(derivePetState({ celebrate: true, justCompleted: true })).toBe("jump");
  });

  it("waves after completing a turn", () => {
    expect(derivePetState({ justCompleted: true })).toBe("wave");
    expect(derivePetState({ justCompleted: true, awaitingInput: true })).toBe("wave");
  });

  it("waits when awaiting input", () => {
    expect(derivePetState({ awaitingInput: true })).toBe("waiting");
    expect(derivePetState({ awaitingInput: true, toolRunning: true })).toBe("waiting");
  });

  it("runs while a tool is executing", () => {
    expect(derivePetState({ toolRunning: true })).toBe("run");
    expect(derivePetState({ toolRunning: true, busy: true })).toBe("run");
  });

  it("reviews while reasoning", () => {
    expect(derivePetState({ reasoning: true })).toBe("review");
    expect(derivePetState({ reasoning: true, busy: true })).toBe("review");
  });

  it("runs on generic busy", () => {
    expect(derivePetState({ busy: true })).toBe("run");
  });

  it("maps the full activity matrix consistently", () => {
    const matrix: Array<[PetActivity, string]> = [
      [{ error: true }, "failed"],
      [{ celebrate: true }, "jump"],
      [{ justCompleted: true }, "wave"],
      [{ awaitingInput: true }, "waiting"],
      [{ toolRunning: true }, "run"],
      [{ reasoning: true }, "review"],
      [{ busy: true }, "run"],
      [{}, "idle"],
    ];
    for (const [input, expected] of matrix) {
      expect(derivePetState(input)).toBe(expected);
    }
  });
});
