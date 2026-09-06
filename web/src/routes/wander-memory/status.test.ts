import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/wander-memory";
import {
  serverStatusPresentation,
  wanderStatusErrorText,
} from "./status";

describe("Wander Memory server status presentation", () => {
  it("distinguishes client mode from actual server connectivity", () => {
    expect(serverStatusPresentation({
      mode: "live",
      loading: true,
      hasData: false,
      hasError: false,
    })).toEqual({ label: "checking", tone: "neutral" });
    expect(serverStatusPresentation({
      mode: "live",
      loading: false,
      hasData: false,
      hasError: true,
    })).toEqual({ label: "offline", tone: "danger" });
    expect(serverStatusPresentation({
      mode: "live",
      loading: false,
      hasData: true,
      hasError: false,
    })).toEqual({ label: "live", tone: "success" });
    expect(serverStatusPresentation({
      mode: "demo",
      loading: false,
      hasData: true,
      hasError: false,
    })).toEqual({ label: "demo", tone: "warning" });
  });

  it("turns network failures into actionable offline copy", () => {
    expect(wanderStatusErrorText(new ApiError(
      "network_failure",
      "no response from server",
      null,
    ))).toBe("offline — start MemOS or update endpoint settings below");
  });
});
