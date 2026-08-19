// errors.test.ts — §5.4 code → treatment exhaustiveness + toApiError coercion.
import { describe, expect, it } from 'vitest';
import { ApiError, COLLISION_ERROR_CODES, toApiError, treatmentFor } from './errors';

describe('treatmentFor (§5.4)', () => {
  it.each([
    ['bad_request', 'inline'],
    ['not_found', 'toast'],
    ['unknown_op', 'toast'],
    ['conflict', 'toast'],
    ['collision_conflict', 'toast'],
    ['llm_unavailable', 'banner'],
    ['network_failure', 'banner'],
    ['backend_probe_failed', 'toast'],
    ['collision_parse_failed', 'card'],
    ['collision_validation_failed', 'card'],
    ['collision_apply_failed', 'card'],
    ['internal', 'toast'],
  ] as const)('%s → %s', (code, kind) => {
    const t = treatmentFor(new ApiError(code, 'boom', null));
    expect(t.kind).toBe(kind);
    expect(t.text.length).toBeGreaterThan(0);
  });

  it('collision error cards are fail-closed ("memory was NOT stored")', () => {
    for (const code of COLLISION_ERROR_CODES) {
      const t = treatmentFor(new ApiError(code, 'x', null));
      expect(t.kind).toBe('card');
      expect(t.text).toContain('NOT stored');
    }
  });

  it('unknown codes fall back to a toast naming the code', () => {
    const t = treatmentFor(new ApiError('some_future_code', 'msg', 500));
    expect(t.kind).toBe('toast');
    expect(t.text).toContain('some_future_code');
  });

  it('ApiError.network wraps a cause with network_failure', () => {
    const err = ApiError.network(new Error('refused'));
    expect(err.code).toBe('network_failure');
    expect(err.status).toBeNull();
    expect(err.message).toContain('refused');
  });
});

describe('toApiError', () => {
  it('passes ApiError through unchanged', () => {
    const err = new ApiError('not_found', 'nope', 404);
    expect(toApiError(err)).toBe(err);
    const network = ApiError.network(new Error('refused'));
    expect(toApiError(network)).toBe(network);
  });

  it('coerces a plain Error into a network_failure ApiError', () => {
    const err = toApiError(new Error('boom'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('network_failure');
    expect(err.status).toBeNull();
    expect(err.message).toContain('boom');
  });

  it('coerces an arbitrary value into an unknown ApiError', () => {
    const err = toApiError({ weird: true });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('unknown');
    expect(err.status).toBeNull();
  });

  it('coerces null/undefined into an unknown ApiError', () => {
    expect(toApiError(null).code).toBe('unknown');
    expect(toApiError(undefined).code).toBe('unknown');
  });
});
