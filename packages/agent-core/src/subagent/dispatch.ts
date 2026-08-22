import type { SubagentPool } from "./pool.js";
import type { SubagentResult } from "./types.js";

export interface DelegateTaskArgs {
  agent: string;
  task: string;
  context?: string;
  timeout?: number;
}

export async function delegateTask(pool: SubagentPool, args: DelegateTaskArgs): Promise<SubagentResult> {
  return pool.dispatch({
    agentId: args.agent,
    task: args.task,
    context: args.context,
    timeout: args.timeout,
  });
}
