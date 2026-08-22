import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../types.js";
import {
  clearContextEngines,
  compressWithActiveEngine,
  getActiveContextEngine,
  getContextEngine,
  listContextEngines,
  registerContextEngine,
  setActiveContextEngine,
} from "./context-plugin.js";

describe("context engine plugin registry", () => {
  beforeEach(() => {
    clearContextEngines();
  });

  afterEach(() => {
    clearContextEngines();
  });

  it("registers and retrieves engines", () => {
    registerContextEngine({
      slug: "noop",
      name: "Noop Engine",
      compress: async () => undefined,
    });

    expect(getContextEngine("noop")?.name).toBe("Noop Engine");
    expect(listContextEngines()).toHaveLength(1);
  });

  it("compresses with the active engine", async () => {
    registerContextEngine({
      slug: "summary",
      name: "Summary Engine",
      compress: async (messages: Message[]) => ({
        messages,
        summary: "compressed",
        tokensSaved: 10,
      }),
    });

    const result = await compressWithActiveEngine([]);
    expect(result?.summary).toBe("compressed");
    expect(result?.tokensSaved).toBe(10);
  });

  it("allows switching active engines", () => {
    registerContextEngine({
      slug: "a",
      name: "A",
      compress: async () => undefined,
    });
    registerContextEngine({
      slug: "b",
      name: "B",
      compress: async () => undefined,
    });

    expect(getActiveContextEngine()).toBe("a");
    expect(setActiveContextEngine("b")).toBe(true);
    expect(getActiveContextEngine()).toBe("b");
    expect(setActiveContextEngine("missing")).toBe(false);
  });

  it("clears active slug after clear", () => {
    registerContextEngine({
      slug: "custom",
      name: "Custom",
      compress: async () => undefined,
    });
    clearContextEngines();
    expect(getActiveContextEngine()).toBeUndefined();
  });
});
