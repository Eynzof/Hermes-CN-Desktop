// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/errors.ts — ApiError class + the §5.4 code → user-treatment
// table, ported from WanderMemory `web/app/src/api/errors.ts`. Adds `toApiError`
// for coercing arbitrary thrown values (transport errors, unknown payloads)
// into the ApiError contract.
// ─────────────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly code: string;
  readonly status: number | null; // HTTP status, null for network/WS failures

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  static network(cause: unknown): ApiError {
    const msg = cause instanceof Error ? cause.message : String(cause);
    return new ApiError('network_failure', `no response from server — ${msg}`, null);
  }
}

export type ErrorTreatment =
  | { kind: 'inline'; text: string }
  | { kind: 'toast'; text: string }
  | { kind: 'banner'; text: string }
  | { kind: 'card'; text: string };

/** §5.4 error mapping — every documented code has exactly one treatment. */
export function treatmentFor(err: ApiError): ErrorTreatment {
  switch (err.code) {
    case 'bad_request':
      return { kind: 'inline', text: err.message };
    case 'not_found':
      return { kind: 'toast', text: 'memory not found — the list may be stale' };
    case 'unknown_op':
      return { kind: 'toast', text: `client bug: unknown op (${err.message})` };
    case 'conflict':
      return { kind: 'toast', text: 'memory system not started' };
    case 'collision_conflict':
      return { kind: 'toast', text: 'concurrent write, please retry' };
    case 'llm_unavailable':
    case 'network_failure':
      return { kind: 'banner', text: 'LLM server unavailable' };
    case 'backend_probe_failed':
      return { kind: 'toast', text: `backend probe failed: ${err.message}` };
    case 'collision_parse_failed':
    case 'collision_validation_failed':
      return { kind: 'card', text: `memory was NOT stored — ${err.message}` };
    case 'collision_apply_failed':
      return {
        kind: 'card',
        text: `memory was NOT stored — store restored to pre-operation state (${err.message})`,
      };
    case 'internal':
      return { kind: 'toast', text: `internal error: ${err.message}` };
    default:
      return { kind: 'toast', text: `${err.code}: ${err.message}` };
  }
}

/** Collision error codes are fail-closed: nothing was stored. */
export const COLLISION_ERROR_CODES = [
  'collision_parse_failed',
  'collision_validation_failed',
  'collision_apply_failed',
] as const;

/**
 * Coerce any thrown value into an ApiError:
 *  - ApiError → passthrough (preserves code/status)
 *  - Error → network failure (no HTTP response was received)
 *  - anything else → "unknown"
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) return ApiError.network(err);
  return new ApiError('unknown', `unknown error: ${String(err)}`, null);
}
