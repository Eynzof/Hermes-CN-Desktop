import { describe, expect, it } from "vitest";
import { createBackend, isTerminalEnvType } from "./index.js";

describe("terminal backends", () => {
  it("creates a backend for every supported kind", () => {
    for (const kind of ["local", "docker", "ssh", "singularity", "modal", "daytona", "vercel_sandbox"] as const) {
      expect(createBackend(kind, {}).kind).toBe(kind);
    }
  });

  it("validates env type strings", () => {
    expect(isTerminalEnvType("docker")).toBe(true);
    expect(isTerminalEnvType("unknown")).toBe(false);
  });

  it("returns degraded stub result for remote backends", async () => {
    const backend = createBackend("docker", {});
    const result = await backend.execute({ command: "echo hi", cwd: "/" });
    expect(result.degraded).toBeDefined();
    expect(result.output).toContain("docker");
  });

  it("throws on unknown backend", () => {
    expect(() => createBackend("bad" as never, {})).toThrow();
  });
});
