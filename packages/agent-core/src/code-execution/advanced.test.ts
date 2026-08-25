import { describe, expect, it, vi } from "vitest";
import { createSandboxBackend, listSandboxKinds } from "./sandbox.js";
import { DaemonPool } from "./daemon-pool.js";
import { capOutput, normalizeLimits, scrubEnv } from "./limits.js";

describe("sandbox backends (P1-14)", () => {
  it("local backend uses the injected runner", async () => {
    const runner = vi.fn().mockResolvedValue("ran!");
    const backend = createSandboxBackend({ kind: "local", localRunner: runner });
    const result = await backend.run("print(1)", "python", 10);
    expect(result.stdout).toBe("ran!");
    expect(runner).toHaveBeenCalledWith("print(1)", "python");
  });

  it("remote backends delegate to the managed runtime with an honest message", async () => {
    const backend = createSandboxBackend({ kind: "docker", target: "sandbox-1" });
    const result = await backend.run("x", "bash", 5);
    expect(result.stdout).toContain("docker");
    expect(result.stdout).toContain("delegated to the managed Python runtime");
  });

  it("lists all sandbox kinds", () => {
    expect(listSandboxKinds()).toEqual(["local", "docker", "ssh", "modal", "daytona", "vercel"]);
  });
});

describe("daemon pool (P1-14)", () => {
  it("bounds concurrency and queues overflow", async () => {
    let release: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const backend = {
      run: vi.fn().mockImplementation(async () => {
        await gate;
        return { status: "success", stdout: "ok", stderr: "", durationMs: 1 };
      }),
    };
    const pool = new DaemonPool({ backend, concurrency: 1 });

    const p1 = pool.run("a", "python", 10);
    const p2 = pool.run("b", "python", 10);
    expect(pool.active).toBe(1);
    expect(pool.queued).toBe(1);

    release!();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.stdout).toBe("ok");
    expect(r2.stdout).toBe("ok");
    expect(pool.queued).toBe(0);
  });

  it("reports idle expiration", () => {
    let clock = 0;
    const backend = { run: async () => ({ status: "success" as const, stdout: "", stderr: "", durationMs: 0 }) };
    const pool = new DaemonPool({ backend, idleMs: 100, now: () => clock });
    expect(pool.idleExpired).toBe(false); // lastActive == now at construction
    clock = 150;
    expect(pool.idleExpired).toBe(true);
  });
});

describe("resource limits + env scrubbing (P1-14)", () => {
  it("caps output to the configured limit", () => {
    expect(capOutput("hello", 3)).toBe("hel\n… truncated to 3 chars");
    expect(capOutput("hello", 10)).toBe("hello");
  });

  it("normalizes limits with defaults", () => {
    expect(normalizeLimits()).toEqual({ maxOutputChars: 100_000, maxRuntimeSeconds: 120, maxMemoryMb: 2048 });
    expect(normalizeLimits({ maxMemoryMb: 512 }).maxMemoryMb).toBe(512);
  });

  it("scrubs secret-looking env vars but keeps safe ones", () => {
    const env = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-123",
      PASSWORD: "hunter2",
      MODEL_NAME: "gpt-4o",
      ALLOWED: "x",
    };
    const scrubbed = scrubEnv(env, ["ALLOWED"]);
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.MODEL_NAME).toBe("gpt-4o");
    expect(scrubbed.ALLOWED).toBe("x");
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.PASSWORD).toBeUndefined();
  });
});
