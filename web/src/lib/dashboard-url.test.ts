import { describe, expect, it } from "vitest";
import { dashboardPortFromUrl, dashboardUrlFromInputs } from "./dashboard-url";

describe("dashboardUrlFromInputs", () => {
  it("opens the dashboard origin from gateway health URLs", () => {
    expect(dashboardUrlFromInputs({ healthUrl: "http://127.0.0.1:9120/api/gateway/health" })).toBe(
      "http://localhost:9120/",
    );
  });

  it("falls back to runtime config and then the desktop default", () => {
    expect(dashboardUrlFromInputs({ runtimeConfig: { apiBaseUrl: "http://127.0.0.1:9567" } })).toBe(
      "http://localhost:9567/",
    );
    expect(dashboardUrlFromInputs({})).toBe("http://localhost:9120/");
  });

  it("does not accept non-browser or relative URLs", () => {
    expect(dashboardUrlFromInputs({ healthUrl: "file:///tmp/x", envOrigin: "/api" })).toBe(
      "http://localhost:9120/",
    );
  });
});

describe("dashboardPortFromUrl", () => {
  it("extracts explicit and default HTTP ports", () => {
    expect(dashboardPortFromUrl("http://localhost:9120/")).toBe("9120");
    expect(dashboardPortFromUrl("http://localhost/")).toBe("80");
    expect(dashboardPortFromUrl("bad")).toBe("9120");
  });
});
