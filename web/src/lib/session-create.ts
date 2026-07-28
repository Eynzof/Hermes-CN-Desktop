export interface CreateSessionOptions {
  activate?: boolean;
  cwd?: string;
  model?: string;
  provider?: string;
}

export interface SessionCreateParams extends Record<string, unknown> {
  cwd?: string;
  model?: string;
  provider?: string;
}

export function buildSessionCreateParams(
  options?: CreateSessionOptions,
): SessionCreateParams {
  const params: SessionCreateParams = {};
  const cwd = options?.cwd?.trim();
  const model = options?.model?.trim();
  const provider = options?.provider?.trim();
  if (cwd) params.cwd = cwd;
  if (model) params.model = model;
  if (provider) params.provider = provider;
  return params;
}
