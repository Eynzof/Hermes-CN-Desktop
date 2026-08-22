import { describe, expect, it } from "vitest";
import { clampScale, derivePetState, InMemoryPetStore } from "./index.js";

describe("pet state", () => {
  it("prioritizes error over celebrate", () => {
    expect(derivePetState({ error: true, celebrate: true })).toBe("failed");
  });

  it("falls back to idle", () => {
    expect(derivePetState({})).toBe("idle");
  });

  it("maps tool running to run", () => {
    expect(derivePetState({ toolRunning: true })).toBe("run");
  });
});

describe("pet constants", () => {
  it("clamps scale", () => {
    expect(clampScale(0.05)).toBe(0.1);
    expect(clampScale(5)).toBe(3.0);
    expect(clampScale(0.5)).toBe(0.5);
  });
});

describe("pet store", () => {
  it("stores and loads pets", async () => {
    const store = new InMemoryPetStore();
    await store.install("boba", { enabled: true, displayName: "Boba" });
    const loaded = await store.load("boba");
    expect(loaded?.displayName).toBe("Boba");
  });
});
