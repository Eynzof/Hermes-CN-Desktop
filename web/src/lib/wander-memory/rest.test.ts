// rest.test.ts — MemOsRestClient against a mocked Hermes transport.
// Asserts the exact wire contract of the MemOS §4.1 API (§5.2): relative vs
// absolute transport selection, method/path/body shape, error mapping
// (Appendix A.10) and timeout policy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors';
import { MemOsRestClient, adaptTransportError, isAbsoluteRequestUrl, resolveRequestUrl } from './rest';

const transportMocks = vi.hoisted(() => ({
  fetchJSON: vi.fn(),
  fetchExternalJSON: vi.fn(),
}));

vi.mock('../transport', () => ({
  fetchJSON: transportMocks.fetchJSON,
  fetchExternalJSON: transportMocks.fetchExternalJSON,
}));

type Sent = { url: string; init: RequestInit };

beforeEach(() => {
  transportMocks.fetchJSON.mockReset();
  transportMocks.fetchExternalJSON.mockReset();
  transportMocks.fetchJSON.mockResolvedValue({});
  transportMocks.fetchExternalJSON.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastSent(mock: ReturnType<typeof vi.fn>): Sent {
  expect(mock).toHaveBeenCalledTimes(1);
  const [url, init] = mock.mock.calls[0] as [string, RequestInit];
  return { url, init };
}

describe('transport split (relative vs absolute)', () => {
  it('relative origin "" uses fetchJSON with the as-is /v1 path', async () => {
    await new MemOsRestClient('').health();
    const sent = lastSent(transportMocks.fetchJSON);
    expect(sent.url).toBe('/v1/health');
    expect(transportMocks.fetchExternalJSON).not.toHaveBeenCalled();
  });

  it('relative origin "/v1" uses fetchJSON with the as-is path', async () => {
    await new MemOsRestClient('/v1').health();
    expect(lastSent(transportMocks.fetchJSON).url).toBe('/v1/health');
    expect(transportMocks.fetchExternalJSON).not.toHaveBeenCalled();
  });

  it('absolute origin uses fetchExternalJSON with the joined URL', async () => {
    await new MemOsRestClient('http://127.0.0.1:18400').health();
    const sent = lastSent(transportMocks.fetchExternalJSON);
    expect(sent.url).toBe('http://127.0.0.1:18400/v1/health');
    expect(transportMocks.fetchJSON).not.toHaveBeenCalled();
  });

  it('absolute origin with a trailing slash or /v1 suffix still joins cleanly', async () => {
    await new MemOsRestClient('http://127.0.0.1:18400/').health();
    expect(lastSent(transportMocks.fetchExternalJSON).url).toBe('http://127.0.0.1:18400/v1/health');
    transportMocks.fetchExternalJSON.mockClear();
    await new MemOsRestClient('http://127.0.0.1:18400/v1').health();
    expect(lastSent(transportMocks.fetchExternalJSON).url).toBe('http://127.0.0.1:18400/v1/health');
  });

  it('resolveRequestUrl/isAbsoluteRequestUrl helpers behave', () => {
    expect(resolveRequestUrl('', '/health')).toBe('/v1/health');
    expect(resolveRequestUrl('/v1', '/health')).toBe('/v1/health');
    expect(resolveRequestUrl('http://h:18400', '/health')).toBe('http://h:18400/v1/health');
    expect(isAbsoluteRequestUrl('http://h:1/x')).toBe(true);
    expect(isAbsoluteRequestUrl('/v1/x')).toBe(false);
  });
});

describe('wire payloads', () => {
  it('addMemory POSTs { text } — never { memory }', async () => {
    await new MemOsRestClient('http://api.test').addMemory('用户对花生过敏', { type: 'fact' });
    const { url, init } = lastSent(transportMocks.fetchExternalJSON);
    expect(init.method).toBe('POST');
    expect(url).toBe('http://api.test/v1/memories');
    expect(JSON.parse(String(init.body))).toEqual({ text: '用户对花生过敏', metadata: { type: 'fact' } });
  });

  it('addMemory omits metadata when absent', async () => {
    await new MemOsRestClient('http://api.test').addMemory('x');
    const { init } = lastSent(transportMocks.fetchExternalJSON);
    expect(JSON.parse(String(init.body))).toEqual({ text: 'x' });
  });

  it('search uses ?q= URL-encoded CJK and top_k', async () => {
    await new MemOsRestClient('http://api.test').search('花生 过敏', 3);
    const { url, init } = lastSent(transportMocks.fetchExternalJSON);
    expect(init.method).toBe('GET');
    const expected = new URLSearchParams({ q: '花生 过敏', top_k: '3' }).toString();
    expect(url).toBe(`http://api.test/v1/memories?${expected}`);
    const got = new URL(url).searchParams;
    expect(got.get('q')).toBe('花生 过敏');
    expect(got.get('top_k')).toBe('3');
  });

  it('list hits GET /memories without params', async () => {
    await new MemOsRestClient('http://api.test').list();
    expect(lastSent(transportMocks.fetchExternalJSON).url).toBe('http://api.test/v1/memories');
  });

  it('get/delete encode the id in the path', async () => {
    const client = new MemOsRestClient('http://api.test');
    await client.get('a/b');
    expect(lastSent(transportMocks.fetchExternalJSON).url).toBe('http://api.test/v1/memories/a%2Fb');
    transportMocks.fetchExternalJSON.mockClear();
    transportMocks.fetchExternalJSON.mockResolvedValue(undefined);
    await client.delete('a/b');
    expect(lastSent(transportMocks.fetchExternalJSON).url).toBe('http://api.test/v1/memories/a%2Fb');
    expect(lastSent(transportMocks.fetchExternalJSON).init.method).toBe('DELETE');
  });

  it('dialogue/chat/context/maintenance bodies', async () => {
    const client = new MemOsRestClient('http://api.test');
    await client.addDialogue('用户: …');
    await client.chat('你好');
    await client.context('花生', 2);
    await client.maintenance();
    const calls = transportMocks.fetchExternalJSON.mock.calls as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe('http://api.test/v1/dialogues');
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ dialogue: '用户: …' });
    expect(calls[1][0]).toBe('http://api.test/v1/chat');
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ query: '你好' });
    expect(calls[2][0]).toBe('http://api.test/v1/context');
    expect(JSON.parse(String(calls[2][1].body))).toEqual({ query: '花生', top_k: 2 });
    expect(calls[3][0]).toBe('http://api.test/v1/maintenance');
    expect(JSON.parse(String(calls[3][1].body))).toEqual({});
  });

  it('chat surfaces the additive dream trace when the server sends it', async () => {
    transportMocks.fetchExternalJSON.mockResolvedValue({
      reply: '你对花生过敏。',
      dreamed_keywords: ['花生', '过敏'],
      grounded_memories: [{ id: 'm1', memory: '用户对花生过敏', metadata: { type: 'fact' } }],
    });
    const res = await new MemOsRestClient('http://api.test').chat('今天吃什么');
    expect(res).toEqual({
      reply: '你对花生过敏。',
      dreamed_keywords: ['花生', '过敏'],
      grounded_memories: [{ id: 'm1', memory: '用户对花生过敏', metadata: { type: 'fact' } }],
    });
  });

  it('chat without trace fields still parses (old-server compatibility)', async () => {
    transportMocks.fetchExternalJSON.mockResolvedValue({ reply: 'hi' });
    const res = await new MemOsRestClient('http://api.test').chat('x');
    expect(res.reply).toBe('hi');
    expect(res.dreamed_keywords).toBeUndefined();
  });
});

describe('error + edge-body handling', () => {
  it.each([
    'bad_request',
    'not_found',
    'unknown_op',
    'conflict',
    'collision_conflict',
    'llm_unavailable',
    'backend_probe_failed',
    'collision_parse_failed',
    'collision_validation_failed',
    'collision_apply_failed',
    'internal',
  ])('documented error body maps to ApiError (%s)', async (code) => {
    transportMocks.fetchExternalJSON.mockRejectedValue(
      new Error(`HTTP 400: ${JSON.stringify({ error: { code, message: `boom ${code}` } })}`),
    );
    const err = await new MemOsRestClient('http://api.test').health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(code);
    expect(err.message).toBe(`boom ${code}`);
    expect(err.status).toBe(400);
  });

  it('non-documented error body never crashes the UI (5xx → internal)', async () => {
    transportMocks.fetchExternalJSON.mockRejectedValue(
      new Error('HTTP 500: {"unexpected": true}'),
    );
    const err = await new MemOsRestClient('http://api.test').health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('internal');
    expect(err.status).toBe(500);
  });

  it('non-documented error body on 4xx → unknown', async () => {
    transportMocks.fetchExternalJSON.mockRejectedValue(new Error('HTTP 418: teapot'));
    const err = await new MemOsRestClient('http://api.test').health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('unknown');
    expect(err.message).toContain('teapot');
  });

  it('timeout/abort → network_failure', async () => {
    const timeoutErr = new DOMException('The operation was aborted.', 'TimeoutError');
    transportMocks.fetchExternalJSON.mockRejectedValue(timeoutErr);
    const err = await new MemOsRestClient('http://api.test').health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('network_failure');
    expect(err.status).toBeNull();
  });

  it('network error (no HTTP response) → network_failure', async () => {
    transportMocks.fetchExternalJSON.mockRejectedValue(new Error('Failed to fetch'));
    const err = await new MemOsRestClient('http://api.test').health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('network_failure');
    expect(err.message).toContain('Failed to fetch');
  });

  it('DELETE with an empty 204 body (SyntaxError from transport) is success-with-no-payload', async () => {
    transportMocks.fetchExternalJSON.mockRejectedValue(new SyntaxError('Unexpected end of JSON input'));
    await expect(new MemOsRestClient('http://api.test').delete('m1')).resolves.toBeUndefined();
  });

  it('DELETE with a real 404 still throws ApiError(not_found)', async () => {
    transportMocks.fetchExternalJSON.mockRejectedValue(
      new Error('HTTP 404: {"error":{"code":"not_found","message":"gone"}}'),
    );
    const err = await new MemOsRestClient('http://api.test').delete('m1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('not_found');
  });
});

describe('timeout policy (§5.2)', () => {
  it('no-LLM endpoints pass a client AbortSignal (10 s)', async () => {
    await new MemOsRestClient('http://api.test').health();
    const { init } = lastSent(transportMocks.fetchExternalJSON);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
  });

  it('/chat and /dialogues have NO client timeout', async () => {
    const client = new MemOsRestClient('http://api.test');
    await client.chat('x');
    expect(lastSent(transportMocks.fetchExternalJSON).init.signal).toBeUndefined();
    transportMocks.fetchExternalJSON.mockClear();
    await client.addDialogue('y');
    expect(lastSent(transportMocks.fetchExternalJSON).init.signal).toBeUndefined();
  });
});

describe('adaptTransportError', () => {
  it('passes ApiError through', () => {
    const err = new ApiError('conflict', 'no', 409);
    expect(adaptTransportError(err)).toBe(err);
  });

  it('parses documented error bodies from transport HTTP errors', () => {
    const out = adaptTransportError(
      new Error('HTTP 404: ' + JSON.stringify({ error: { code: 'not_found', message: 'nope' } })),
    );
    expect(out).toMatchObject({ code: 'not_found', message: 'nope', status: 404 });
  });

  it('accepts an optional hint appended to the unexpected-body message', () => {
    const out = adaptTransportError(new Error('HTTP 500: boom'), ' — is the server running?');
    expect(out.code).toBe('internal');
    expect(out.message).toContain('is the server running?');
  });
});
