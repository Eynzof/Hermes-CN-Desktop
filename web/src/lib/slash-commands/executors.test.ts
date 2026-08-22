import { describe, expect, it } from "vitest";
import { EXECUTORS, runExecutor } from "./executors";

describe("EXECUTORS", () => {
  it("version returns version lines", () => {
    const reply = EXECUTORS.version({
      args: "",
      buildInfo: { version: "0.8.0", commit: "abc123", backendVersion: "0.18.0" },
    });
    expect(reply.text).toContain("Desktop version: 0.8.0");
    expect(reply.text).toContain("Backend version: 0.18.0");
    expect(reply.format).toBe("plain");
  });

  it("egress reports running state", () => {
    const reply = EXECUTORS.egress({
      args: "",
      status: { gateway_running: true, active_sessions: 3 },
    });
    expect(reply.text).toContain("Egress proxy active");
    expect(reply.text).toContain("3");
  });

  it("egress reports stopped state", () => {
    const reply = EXECUTORS.egress({ args: "", status: { gateway_running: false } });
    expect(reply.text).toContain("not running");
  });

  it("profile lists profiles when no args", () => {
    const reply = EXECUTORS.profile({
      args: "",
      activeProfile: "default",
      profiles: ["default", "work"],
    });
    expect(reply.text).toContain("Active profile: default");
    expect(reply.text).toContain("work");
  });

  it("profile switches to existing profile", () => {
    const reply = EXECUTORS.profile({
      args: "work",
      activeProfile: "default",
      profiles: ["default", "work"],
    });
    expect(reply.text).toContain("Switched to profile: work");
  });

  it("profile errors on unknown profile", () => {
    const reply = EXECUTORS.profile({ args: "missing", profiles: ["default"] });
    expect(reply.text).toContain("Unknown profile");
  });

  it("bundles lists installed bundles", () => {
    const reply = EXECUTORS.bundles({ args: "", bundles: ["core", "web"] });
    expect(reply.text).toContain("core");
    expect(reply.text).toContain("web");
  });

  it("bundles reports none installed", () => {
    const reply = EXECUTORS.bundles({ args: "" });
    expect(reply.text).toContain("No skill bundles installed");
  });

  it("gateway_help lists commands", () => {
    const reply = EXECUTORS.gateway_help({
      args: "",
      commands: [
        { name: "new", description: "Start a fresh session", category: "Session" },
      ],
    });
    expect(reply.text).toContain("/new");
    expect(reply.text).toContain("Start a fresh session");
    expect(reply.format).toBe("markdown");
  });

  it("gateway_help shows command-specific help", () => {
    const reply = EXECUTORS.gateway_help({
      args: "new",
      commands: [{ name: "new", description: "Start a fresh session", category: "Session" }],
    });
    expect(reply.text).toContain("**/new**");
    expect(reply.text).toContain("Start a fresh session");
  });

  it("gateway_commands groups by category", () => {
    const reply = EXECUTORS.gateway_commands({
      args: "",
      commands: [
        { name: "new", description: "Start", category: "Session" },
        { name: "model", description: "Switch", category: "Configuration" },
      ],
    });
    expect(reply.text).toContain("Session");
    expect(reply.text).toContain("Configuration");
    expect(reply.text).toContain("/new");
    expect(reply.text).toContain("/model");
  });

  it("runExecutor dispatches by key", () => {
    const reply = runExecutor("version", { args: "", buildInfo: { version: "1.0.0" } });
    expect(reply.text).toContain("1.0.0");
  });
});
