import type { CodeJob, CodeLanguage, CodeResult, CodeRunStatus } from "./types.js";

export interface CodeExecutorBackend {
  run(code: string, language: CodeLanguage, timeout: number): Promise<{
    status: CodeRunStatus;
    stdout: string;
    stderr: string;
    exitCode?: number;
    durationMs: number;
  }>;
}

export class CodeExecutor {
  private backend: CodeExecutorBackend;
  private jobs = new Map<string, CodeJob>();
  private results = new Map<string, CodeResult>();

  constructor(backend: CodeExecutorBackend) {
    this.backend = backend;
  }

  createJob(code: string, language: CodeLanguage, timeout = 30): CodeJob {
    const job: CodeJob = {
      id: `code-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      code,
      language,
      timeout,
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id: string): CodeJob | undefined {
    return this.jobs.get(id);
  }

  async run(job: CodeJob): Promise<CodeResult> {
    const started = performance.now();
    const raw = await this.backend.run(job.code, job.language, job.timeout);
    const result: CodeResult = {
      jobId: job.id,
      status: raw.status,
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
      durationMs: raw.durationMs ?? Math.round(performance.now() - started),
    };
    this.results.set(job.id, result);
    return result;
  }

  status(id: string): CodeResult | undefined {
    return this.results.get(id);
  }
}

export function createStubExecutor(): CodeExecutorBackend {
  return {
    async run(code, language) {
      return {
        status: "success",
        stdout: `Executed ${language} code (${code.length} chars)`,
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  };
}
