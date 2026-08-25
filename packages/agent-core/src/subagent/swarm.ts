/**
 * Subagent swarm — parallel batch delegation.
 *
 * Runs a batch of subagent tasks with bounded concurrency and aggregates the
 * results. Mirrors the Python `tools/agentswarm.py` parallel-batch semantics
 * (roles/nesting are expressed through the task payloads passed by callers).
 */

import type { SubagentPool } from "./pool.js";
import type { SubagentResult, SubagentTask } from "./types.js";

export interface SwarmOptions {
  maxConcurrency?: number;
  signal?: AbortSignal;
}

export interface SwarmSummary {
  total: number;
  succeeded: number;
  failed: number;
  results: SubagentResult[];
}

/** Run a batch of subagent tasks with a concurrency cap. */
export async function runSwarm(
  pool: SubagentPool,
  tasks: SubagentTask[],
  opts: SwarmOptions = {},
): Promise<SwarmSummary> {
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 4);
  const results: SubagentResult[] = new Array(tasks.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      if (opts.signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      results[index] = await pool.dispatch(tasks[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);

  const settled = results.filter((r) => r !== undefined);
  return {
    total: tasks.length,
    succeeded: settled.filter((r) => r.ok).length,
    failed: settled.filter((r) => !r.ok).length,
    results: settled,
  };
}
