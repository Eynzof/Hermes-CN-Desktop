export interface SubagentConfig {
  id: string;
  name: string;
  model?: string;
  instructions?: string;
}

export interface SubagentTask {
  agentId: string;
  task: string;
  context?: string;
  timeout?: number;
}

export interface SubagentResult {
  ok: boolean;
  agentId: string;
  task: string;
  output: string;
  durationMs: number;
}
