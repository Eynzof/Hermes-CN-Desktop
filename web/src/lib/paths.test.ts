import { describe, expect, it } from "vitest";
import { shortenPath } from "./paths";

describe("shortenPath", () => {
  it("shortens macOS home paths", () => {
    expect(shortenPath("/Users/enzo/Documents/project")).toBe("~/Documents/project");
  });

  it("shortens Linux home paths", () => {
    expect(shortenPath("/home/enzo/code/project")).toBe("~/code/project");
  });

  it("shortens Windows home paths", () => {
    expect(shortenPath("C:\\Users\\enzo\\code\\project")).toBe("~\\code\\project");
  });

  it("leaves the home root itself untouched (no sub-path)", () => {
    expect(shortenPath("/Users/enzo")).toBe("/Users/enzo");
    expect(shortenPath("C:\\Users\\enzo")).toBe("C:\\Users\\enzo");
  });

  it("leaves non-home paths untouched", () => {
    expect(shortenPath("/opt/app/data")).toBe("/opt/app/data");
    expect(shortenPath("D:\\work\\project")).toBe("D:\\work\\project");
  });

  it("renders an em dash for empty input", () => {
    expect(shortenPath("")).toBe("—");
  });
});
