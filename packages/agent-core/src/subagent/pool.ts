import type { SubagentConfig, SubagentTask, SubagentResult } from "./types.js";

export interface SubagentSpawnBackend {
  execute(task: SubagentTask): Promise<SubagentResult>;
}

export class SubagentPool {
  private agents = new Map<string, SubagentConfig>();
  private backend: SubagentSpawnBackend;

  constructor(backend: SubagentSpawnBackend) {
    this.backend = backend;
  }

  register(config: SubagentConfig): void {
    this.agents.set(config.id, config);
  }

  resolve(nameOrId: string): SubagentConfig | undefined {
    return (
      this.agents.get(nameOrId) ??
      Array.from(this.agents.values()).find((a) => a.name === nameOrId)
    );
  }

  list(): SubagentConfig[] {
    return Array.from(this.agents.values());
  }

  async dispatch(task: SubagentTask): Promise<SubagentResult> {
    const agent = this.resolve(task.agentId);
    if (!agent) {
      return {
        ok: false,
        agentId: task.agentId,
        task: task.task,
        output: `Unknown subagent: ${task.agentId}`,
        durationMs: 0,
      };
    }
    return this.backend.execute({ ...task, agentId: agent.id });
  }
}
