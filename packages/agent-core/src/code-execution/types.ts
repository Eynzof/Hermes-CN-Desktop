export type CodeLanguage = "python" | "typescript" | "javascript" | "bash";

export interface CodeJob {
  id: string;
  code: string;
  language: CodeLanguage;
  timeout: number;
  createdAt: number;
}

export type CodeRunStatus = "queued" | "running" | "success" | "timeout" | "error";

export interface CodeResult {
  jobId: string;
  status: CodeRunStatus;
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs: number;
}
