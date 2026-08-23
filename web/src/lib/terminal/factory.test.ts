import { describe, expect, it } from "vitest";
import { createBackend, isTerminalEnvType } from "./factory";
import type { TerminalEnvType } from "./types";

const STUB_KINDS: TerminalEnvType[] = ["docker", "ssh", "singularity", "modal", "daytona", "vercel_sandbox"];

describe("createBackend — local", () => {
  it("creates a local backend", () => {
    const backend = createBackend("local", {});
    expect(backend.kind).toBe("local");
  });

  it("execute reports that the local terminal runs through Rust IPC", async () => {
    const backend = createBackend("local", {});
    await expect(backend.execute({ command: "ls" })).resolves.toEqual({
      output: "",
      exitCode: 0,
      degraded: { reason: "local backend uses Rust IPC", retryHint: "use tauri-bridge" },
    });
  });

  it("createSession throws until the tauri-bridge path is wired", async () => {
    const backend = createBackend("local", {});
    await expect(backend.createSession({ cwd: "/tmp" })).rejects.toThrow(
      "local terminal uses Rust portable-pty via tauri-bridge",
    );
  });

  it("cleanup resolves without side effects", async () => {
    await expect(createBackend("local", {}).cleanup()).resolves.toBeUndefined();
  });
});

describe("createBackend — stub backends", () => {
  for (const kind of STUB_KINDS) {
    it(`creates a ${kind} backend with the right kind`, () => {
      expect(createBackend(kind, {}).kind).toBe(kind);
    });

    it(`${kind} execute returns a degraded stub result`, async () => {
      const result = await createBackend(kind, {}).execute({ command: "echo hi" });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(`[${kind}]`);
      expect(result.degraded?.reason).toContain(kind);
      expect(result.degraded?.retryHint).toBeTruthy();
    });

    it(`${kind} createSession is not implemented in the browser`, async () => {
      await expect(createBackend(kind, {}).createSession({ cwd: "/tmp" })).rejects.toThrow(
        "interactive session not implemented in browser",
      );
    });
  }
});

describe("createBackend — unknown kinds", () => {
  it("throws for unknown backend kinds", () => {
    expect(() => createBackend("bogus" as TerminalEnvType, {})).toThrow(
      "Unknown terminal backend: bogus",
    );
  });
});

describe("isTerminalEnvType", () => {
  it("accepts every known env type", () => {
    for (const kind of [...STUB_KINDS, "local"]) {
      expect(isTerminalEnvType(kind)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isTerminalEnvType("bogus")).toBe(false);
    expect(isTerminalEnvType("")).toBe(false);
    expect(isTerminalEnvType("DOCKER")).toBe(false);
    expect(isTerminalEnvType(undefined as unknown as string)).toBe(false);
  });
});
