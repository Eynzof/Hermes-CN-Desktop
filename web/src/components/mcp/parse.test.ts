import { describe, expect, it } from "vitest";
import { parseArgs } from "./parse";
describe("MCP process arguments", () => {
  it("preserves quoted Windows paths, commas and empty arguments", () => {
    expect(parseArgs(String.raw`--file "C:\Program Files\MCP\server.py" 'a,b' "" --stdio`))
      .toEqual(["--file", String.raw`C:\Program Files\MCP\server.py`, "a,b", "", "--stdio"]);
  });
  it("rejects an unfinished quoted argument before saving", () => {
    expect(() => parseArgs('--file "unfinished')).toThrow("引号未闭合");
  });
});
