/**
 * Code-execution resource limits + env scrubbing.
 *
 * Mirrors Python `tools/daemonpool.py` resource limits and the project/strict
 * mode env scrubbing: outputs are capped, runtimes are bounded, and
 * secret-looking environment variables never reach sandboxed code.
 */

export interface CodeResourceLimits {
  /** Max stdout+stderr characters retained. Default 100_000. */
  maxOutputChars?: number;
  /** Max runtime seconds enforced by the executor. Default 120. */
  maxRuntimeSeconds?: number;
  /** Optional memory ceiling in MB (enforced by the sandbox backend). */
  maxMemoryMb?: number;
}

export const DEFAULT_CODE_RESOURCE_LIMITS: Required<CodeResourceLimits> = {
  maxOutputChars: 100_000,
  maxRuntimeSeconds: 120,
  maxMemoryMb: 2048,
};

export function normalizeLimits(limits?: CodeResourceLimits): Required<CodeResourceLimits> {
  return {
    maxOutputChars: limits?.maxOutputChars ?? DEFAULT_CODE_RESOURCE_LIMITS.maxOutputChars,
    maxRuntimeSeconds: limits?.maxRuntimeSeconds ?? DEFAULT_CODE_RESOURCE_LIMITS.maxRuntimeSeconds,
    maxMemoryMb: limits?.maxMemoryMb ?? DEFAULT_CODE_RESOURCE_LIMITS.maxMemoryMb,
  };
}

/** Cap output strings to the configured limit. */
export function capOutput(output: string, maxOutputChars: number): string {
  if (output.length <= maxOutputChars) return output;
  return `${output.slice(0, maxOutputChars)}\n… truncated to ${maxOutputChars} chars`;
}

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|passwd|authorization|credential|private[_-]?key)/i;

/** Filter secret-looking entries from an env object before sandbox execution. */
export function scrubEnv(
  env: Record<string, string | undefined>,
  keep: readonly string[] = [],
): Record<string, string> {
  const keepSet = new Set(keep);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (keepSet.has(key)) {
      out[key] = value;
      continue;
    }
    if (SECRET_KEY_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
}
