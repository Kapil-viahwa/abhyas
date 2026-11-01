import { describe, expect, it } from 'vitest';

import { apiBaseUrl, fetchHealth, isHealthPayload, type FetchLike } from './api';

const healthBody = {
  status: 'ok',
  service: 'abhyas-api',
  version: '0.1.0',
  checkedAt: '2025-01-01T00:00:00.000Z',
  checks: { database: 'ok', redis: 'ok' },
};

function fakeFetch(status: number, body: unknown): FetchLike {
  return async () => ({ status, json: async () => body });
}

describe('apiBaseUrl', () => {
  it('falls back to the local API when nothing is configured', () => {
    expect(apiBaseUrl({})).toBe('http://localhost:3001');
  });

  it('prefers the internal URL and strips trailing slashes', () => {
    expect(apiBaseUrl({ API_INTERNAL_URL: 'http://api:3001/' })).toBe('http://api:3001');
  });

  it('uses the public URL when no internal one is set', () => {
    expect(apiBaseUrl({ NEXT_PUBLIC_API_BASE_URL: 'https://api.example.test' })).toBe(
      'https://api.example.test',
    );
  });
});

describe('isHealthPayload', () => {
  it('accepts the API contract', () => {
    expect(isHealthPayload(healthBody)).toBe(true);
  });

  it('rejects payloads missing dependency checks', () => {
    expect(isHealthPayload({ ...healthBody, checks: {} })).toBe(false);
    expect(isHealthPayload('ok')).toBe(false);
    expect(isHealthPayload(null)).toBe(false);
  });
});

describe('fetchHealth', () => {
  it('returns the payload when the API is healthy', async () => {
    const result = await fetchHealth('http://api:3001', fakeFetch(200, healthBody));

    expect(result.error).toBeNull();
    expect(result.payload?.status).toBe('ok');
  });

  it('keeps the payload of a degraded API instead of reporting a transport failure', async () => {
    const degraded = { ...healthBody, status: 'degraded', checks: { database: 'ok', redis: 'down' } };
    const result = await fetchHealth('http://api:3001', fakeFetch(503, degraded));

    expect(result.error).toBeNull();
    expect(result.payload?.status).toBe('degraded');
    expect(result.payload?.checks.redis).toBe('down');
  });

  it('reports an unexpected response body', async () => {
    const result = await fetchHealth('http://api:3001', fakeFetch(200, { unexpected: true }));

    expect(result.payload).toBeNull();
    expect(result.error).toMatch(/Unexpected \/health response/);
  });

  it('reports a transport failure', async () => {
    const result = await fetchHealth('http://api:3001', async () => {
      throw new Error('connect ECONNREFUSED');
    });

    expect(result.payload).toBeNull();
    expect(result.error).toBe('connect ECONNREFUSED');
  });
});
