import { describe, expect, it } from "vitest";
import { desktopBuildPolicy } from "./desktop-build-policy";

describe("desktopBuildPolicy", () => {
  it("keeps every managed surface available in the standard build", () => {
    expect(desktopBuildPolicy("standard")).toEqual({
      defaultConnectionMode: "managed",
      showManagedRuntime: true,
      showKernelSettings: true,
      showDesktopUpdates: true,
    });
  });

  it("makes the shell build attach-only", () => {
    expect(desktopBuildPolicy("shell")).toEqual({
      defaultConnectionMode: "local",
      showManagedRuntime: false,
      showKernelSettings: false,
      showDesktopUpdates: false,
    });
  });
});
