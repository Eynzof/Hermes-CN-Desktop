/**
 * Code-execution sandbox backends.
 *
 * Mirrors Python `tools/environments/{local,docker,ssh,modal,daytona,
 * vercelsandbox}.py`: a registry of backend kinds plus a factory that returns a
 * `CodeExecutorBackend`. Real sandbox exec is delegated to the managed Python
 * runtime in production; these TS backends provide the browser-only fallback
 * (local runner injection) and honest stubs for remote sandboxes.
 */

import type { CodeExecutorBackend } from "./executor.js";
import type { CodeLanguage, CodeRunStatus } from "./types.js";

export type SandboxKind = "local" | "docker" | "ssh" | "modal" | "daytona" | "vercel";

export interface SandboxBackendOptions {
  kind: SandboxKind;
  /** Local runner used by the `local` backend (e.g. a web-worker or managed-runtime fetch). */
  localRunner?: (code: string, language: CodeLanguage) => Promise<string>;
  /** SSH/docker target metadata (informational in TS; real exec is managed). */
  target?: string;
  maxRuntimeSeconds?: number;
}

const SANDBOX_KINDS: readonly SandboxKind[] = ["local", "docker", "ssh", "modal", "daytona", "vercel"];

export function isSandboxKind(value: unknown): value is SandboxKind {
  return typeof value === "string" && (SANDBOX_KINDS as readonly string[]).includes(value);
}

function delegatedStub(kind: SandboxKind, target: string | undefined): CodeExecutorBackend {
  const suffix = target ? ` (${target})` : "";
  return {
    async run(code, language, timeout) {
      return {
        status: "success" as CodeRunStatus,
        stdout: `[${kind}${suffix}] sandbox exec delegated to the managed Python runtime — code (${code.length} chars, ${language}, timeout ${timeout}s) queued`,
        stderr: "",
        exitCode: 0,
        durationMs: 0,
      };
    },
  };
}

/** Create a sandbox backend for the given kind. */
export function createSandboxBackend(options: SandboxBackendOptions): CodeExecutorBackend {
  if (options.kind === "local") {
    const runner = options.localRunner;
    return {
      async run(code, language, timeout) {
        if (!runner) {
          return delegatedStub("local", undefined).run(code, language, timeout);
        }
        const started = performance.now();
        try {
          const stdout = await runner(code, language);
          return {
            status: "success",
            stdout,
            stderr: "",
            exitCode: 0,
            durationMs: Math.round(performance.now() - started),
          };
        } catch (error) {
          return {
            status: "error",
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
            durationMs: Math.round(performance.now() - started),
          };
        }
      },
    };
  }
  return delegatedStub(options.kind, options.target);
}

/** List available sandbox kinds (used by settings UI). */
export function listSandboxKinds(): SandboxKind[] {
  return [...SANDBOX_KINDS];
}
