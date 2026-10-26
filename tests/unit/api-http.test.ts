import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createCaller, buildPath, type Transport } from '@/lib/api/http';
import { ApiError } from '@/lib/api/errors';

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const schema = z.object({ name: z.string() });

describe('createCaller', () => {
  it('returns validated data', async () => {
    const call = createCaller(async () => ok({ name: 'tee' }));
    await expect(call('/x', schema)).resolves.toEqual({ name: 'tee' });
  });

  it('rejects responses that break the contract without leaking details to the UI', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const call = createCaller(async () => ok({ nope: true }));
    const error = await call('/x', schema, { retries: 0 }).catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('invalid_response');
    expect(error.message).not.toMatch(/zod|nope|issues|path|invalid_type/i);
  });

  it('maps the error envelope and generic statuses', async () => {
    const call = createCaller(async () => ok({ error: { code: 'coupon_invalid', message: 'Nope.', fieldErrors: { code: ['bad'] } } }, 422));
    const error = await call('/x', schema, { method: 'POST', body: {} }).catch(e => e);
    expect(error).toMatchObject({ status: 422, code: 'coupon_invalid', message: 'Nope.', fieldErrors: { code: ['bad'] } });

    const plain = createCaller(async () => new Response('<html>boom stack trace</html>', { status: 500 }));
    const generic = await plain('/x', schema, { method: 'POST' }).catch(e => e);
    expect(generic.message).not.toMatch(/boom|stack|html/i);
    expect(generic.code).toBe('server_error');
  });

  it('retries idempotent GETs on 5xx with backoff, then succeeds', async () => {
    let calls = 0;
    const transport: Transport = async () => (++calls < 3 ? ok({ error: { code: 'x', message: 'down' } }, 503) : ok({ name: 'back' }));
    const result = await createCaller(transport)('/x', schema, { retryDelayMs: 0 });
    expect(result).toEqual({ name: 'back' });
    expect(calls).toBe(3);
  });

  it('gives up after the retry budget', async () => {
    let calls = 0;
    const transport: Transport = async () => { calls++; return ok({}, 503); };
    const error = await createCaller(transport)('/x', schema, { retries: 1, retryDelayMs: 0 }).catch(e => e);
    expect(calls).toBe(2);
    expect(error.status).toBe(503);
  });

  it('never retries writes (a retried order must not create two orders)', async () => {
    let calls = 0;
    const transport: Transport = async () => { calls++; return ok({}, 503); };
    await createCaller(transport)('/orders', schema, { method: 'POST', body: {}, retries: 5, retryDelayMs: 0 }).catch(() => undefined);
    expect(calls).toBe(1);
  });

  it('does not retry client errors', async () => {
    let calls = 0;
    const transport: Transport = async () => { calls++; return ok({ error: { code: 'not_found', message: 'x' } }, 404); };
    await createCaller(transport)('/x', schema, { retryDelayMs: 0 }).catch(() => undefined);
    expect(calls).toBe(1);
  });

  it('turns network failures and timeouts into safe ApiErrors', async () => {
    const down = createCaller(async () => { throw new TypeError('fetch failed ECONNREFUSED 10.0.0.5:5432'); });
    const error = await down('/x', schema, { retries: 0 }).catch(e => e);
    expect(error).toMatchObject({ code: 'network_error' });
    expect(error.message).not.toMatch(/ECONNREFUSED|10\.0/);

    const slow = createCaller(async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; });
    expect(await slow('/x', schema, { retries: 0 }).catch(e => e)).toMatchObject({ code: 'timeout', status: 504 });
  });

  it('passes framework control-flow errors through untouched', async () => {
    const bailout = Object.assign(new Error('Dynamic server usage'), { digest: 'DYNAMIC_SERVER_USAGE' });
    const call = createCaller(async () => { throw bailout; });
    await expect(call('/x', schema)).rejects.toBe(bailout);
  });

  it('sends JSON bodies and the idempotency key', async () => {
    const seen: Array<Parameters<Transport>[0]> = [];
    const call = createCaller(async request => { seen.push(request); return ok({ name: 'a' }, 201); });
    await call('/orders', schema, { method: 'POST', body: { a: 1 }, idempotencyKey: 'abc12345-key' });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers['Idempotency-Key']).toBe('abc12345-key');
    expect(seen[0].headers['Content-Type']).toBe('application/json');
    expect(seen[0].body).toBe('{"a":1}');
  });

  it('supports empty (204) responses with a null schema', async () => {
    const call = createCaller(async () => new Response(null, { status: 204 }));
    await expect(call('/auth/logout', null, { method: 'POST' })).resolves.toBeUndefined();
  });
});

describe('buildPath', () => {
  it('serialises query values and skips empty ones', () => {
    expect(buildPath('/p', { a: 1, b: '', c: undefined, d: null, e: 'x y', f: ['1', '2'] })).toBe('/p?a=1&e=x+y&f=1&f=2');
    expect(buildPath('/p?x=1', { y: 2 })).toBe('/p?x=1&y=2');
  });
});
