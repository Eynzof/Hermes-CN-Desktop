import { describe, expect, it } from "vitest";
import { buildConfigUpdateRequest } from "./use-config";

describe("buildConfigUpdateRequest", () => {
  it("wraps the config object for PUT /api/config", () => {
    expect(buildConfigUpdateRequest({ model: "qwen", approval: { mode: "manual" } }))
      .toEqual({
        config: { model: "qwen", approval: { mode: "manual" } },
      });
  });

  it("carries deleted paths as deleted_paths on the wire (#370/#188, Core P-042)", () => {
    expect(
      buildConfigUpdateRequest({ providers: {} }, ["providers.custom:local"]),
    ).toEqual({
      config: { providers: {} },
      deleted_paths: ["providers.custom:local"],
    });
  });

  it("omits deleted_paths when there is nothing to delete", () => {
    expect(buildConfigUpdateRequest({ providers: {} }, [])).toEqual({
      config: { providers: {} },
    });
  });
});
