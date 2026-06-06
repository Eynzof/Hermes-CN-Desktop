import { describe, expect, it } from "vitest";
import type { EnvironmentCheckItem } from "@hermes/protocol";
import { summarizeEnvironmentItems } from "./environment";

function item(status: EnvironmentCheckItem["status"], required = false): EnvironmentCheckItem {
  return {
    id: `${status}-${required}`,
    category: "core",
    label: status,
    status,
    required,
    summary: status,
  };
}

describe("summarizeEnvironmentItems", () => {
  it("counts ok, warning, error, and required errors", () => {
    expect(summarizeEnvironmentItems([
      item("ok", true),
      item("warning"),
      item("error"),
      item("error", true),
      item("unknown"),
    ])).toEqual({ ok: 1, warnings: 1, errors: 2, requiredErrors: 1, total: 5 });
  });
});
