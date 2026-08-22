import { describe, expect, it } from "vitest";
import {
  formatSnapshot,
  prepareSnapshot,
  SNAPSHOT_SUMMARIZE_THRESHOLD,
  type AccessibilityNode,
} from "./snapshot.js";

describe("formatSnapshot", () => {
  it("renders a simple tree with refs", () => {
    const root: AccessibilityNode = {
      role: "WebArea",
      name: "Example",
      children: [
        { role: "link", name: "Home" },
        { role: "button", name: "Submit" },
      ],
    };
    const text = formatSnapshot(root);
    expect(text).toContain("@e1 WebArea Example");
    expect(text).toContain("@e2 link Home");
    expect(text).toContain("@e3 button Submit");
  });

  it("skips generic/none roles", () => {
    const root: AccessibilityNode = {
      role: "WebArea",
      children: [
        { role: "generic", name: "ignored" },
        { role: "link", name: "Click me" },
      ],
    };
    const text = formatSnapshot(root);
    expect(text).not.toContain("generic ignored");
    expect(text).toContain("@e2 link Click me");
  });

  it("indents children", () => {
    const root: AccessibilityNode = {
      role: "WebArea",
      children: [
        {
          role: "navigation",
          name: "Menu",
          children: [{ role: "link", name: "Item" }],
        },
      ],
    };
    const text = formatSnapshot(root);
    expect(text).toContain("  @e2 navigation Menu");
    expect(text).toContain("    @e3 link Item");
  });
});

describe("prepareSnapshot", () => {
  it("returns full snapshot when under threshold", async () => {
    const root: AccessibilityNode = { role: "WebArea", name: "Small" };
    const result = await prepareSnapshot(root);
    expect(result.truncated).toBe(false);
    expect(result.elementCount).toBe(1);
  });

  it("truncates when over threshold", async () => {
    const root: AccessibilityNode = {
      role: "WebArea",
      children: Array.from({ length: 200 }, (_, i) => ({
        role: "link",
        name: `item-${i} `.repeat(200),
      })),
    };
    const result = await prepareSnapshot(root, { maxChars: 200 });
    expect(result.truncated).toBe(true);
    expect(result.elementCount).toBe(201);
    expect(result.text.length).toBeLessThanOrEqual(300);
  });

  it("stores overflow when storeOverflow provided", async () => {
    const root: AccessibilityNode = {
      role: "WebArea",
      children: Array.from({ length: 200 }, (_, i) => ({
        role: "link",
        name: `item-${i} `.repeat(200),
      })),
    };
    const overflowPath = "cache/web/snapshot-1.txt";
    const result = await prepareSnapshot(root, {
      maxChars: 200,
      storeOverflow: async () => overflowPath,
    });
    expect(result.overflowPath).toBe(overflowPath);
  });
});
