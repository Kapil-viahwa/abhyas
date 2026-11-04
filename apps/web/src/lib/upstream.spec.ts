import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_CALL_MAX_RESPONSE_BYTES, ApiCallConfigurationError, GENERIC_API_MESSAGE, apiCall } from './upstream';

/**
 * The web tier's only door to the API, and the three ways it can be made to misbehave:
 * it must not cache one person's data for everybody, must not wait for ever, and must not
 * buffer however much a response claims to be.
 */
describe('apiCall', () => {
  beforeEach(() => {
    process.env.API_INTERNAL_URL = 'http://api.test';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.API_INTERNAL_URL;
  });

  it('refuses to cache a token-bearing response under tags', async () => {
    await expect(
      apiCall('/v1/auth/me', { method: 'GET', accessToken: 'someone-elses-token', tags: ['catalog'] }),
    ).rejects.toBeInstanceOf(ApiCallConfigurationError);
  });

  it('abandons a request that takes longer than the ceiling', async () => {
    vi.stubGlobal('fetch', (_input: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    await expect(apiCall('/health', { method: 'GET', timeoutMs: 5 })).resolves.toEqual({ status: 503, body: null });
  });

  it('refuses a response larger than the cap instead of buffering it', async () => {
    const oversized = 'x'.repeat(API_CALL_MAX_RESPONSE_BYTES + 16);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(oversized, { status: 200 })));

    const result = await apiCall<{ message: string }>('/exams', { method: 'GET' });

    expect(result.status).toBe(502);
    expect(result.body?.message).toBe('The API response was too large.');
  });

  it('never hands raw non-JSON text to a page', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('<html>upstream error at /srv/app/secret-path</html>', { status: 500 })),
    );

    const result = await apiCall<{ message: string }>('/exams', { method: 'GET' });

    // The status is kept so the page can still say it failed; the body is ours, not theirs.
    expect(result.status).toBe(500);
    expect(result.body?.message).toBe(GENERIC_API_MESSAGE);
    expect(JSON.stringify(result.body)).not.toContain('/srv/app');
  });

  it('still parses a normal response', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );

    await expect(apiCall<{ ok: boolean }>('/health', { method: 'GET' })).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
  });
});
