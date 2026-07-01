import { describe, expect, it } from "vitest";
import { decodeStarmapShareCode, encodeStarmapShareCode } from "./starmap";
import type { StarmapGraph } from "@hermes/protocol";

describe("starmap share codes", () => {
  it("round-trips graph payloads through url-safe base64", () => {
    const graph: StarmapGraph = {
      nodes: [{ id: "skill:写作", label: "写作", kind: "skill", useCount: 2 }],
      edges: [{ source: "skill:写作", target: "memory:1" }],
      clusters: [{ category: "creative", count: 1 }],
      memory: [{ source: "memory.md", title: "偏好", body: "喜欢短句" }],
      stats: { total: 1 },
    };

    const code = encodeStarmapShareCode(graph);

    expect(code).not.toMatch(/[+/=]/);
    expect(decodeStarmapShareCode(code)).toEqual(graph);
  });
});
