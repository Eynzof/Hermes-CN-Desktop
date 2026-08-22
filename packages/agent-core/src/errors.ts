export class AgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable = false,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export class AgentAbortError extends AgentError {
  constructor(message = "Turn was interrupted") {
    super(message, "aborted", false);
    this.name = "AgentAbortError";
  }
}

export class ToolError extends AgentError {
  constructor(
    message: string,
    public readonly toolName?: string,
  ) {
    super(message, "tool_error", true);
    this.name = "ToolError";
  }
}

export class ProviderError extends AgentError {
  constructor(
    message: string,
    public readonly provider?: string,
    public readonly statusCode?: number,
  ) {
    super(message, "provider_error", statusCode === undefined || statusCode >= 500 || statusCode === 429);
    this.name = "ProviderError";
  }
}

export function isAbortError(error: unknown): error is AgentAbortError {
  return error instanceof AgentAbortError;
}

export function isRecoverableError(error: unknown): boolean {
  if (error instanceof AgentError) return error.recoverable;
  return false;
}
