import { describe, expect, it } from 'vitest';

import { COIN_RECONCILIATION_TIMEOUT_MS, reconcileCoinWallets } from './coin-reconciliation';

describe('the nightly wallet reconciliation call', () => {
  it('asks the API to reconcile with its own secret and logs the counts', async () => {
    const logged: string[] = [];
    let seenUrl = '';
    let seenSecret = '';

    const result = await reconcileCoinWallets({
      apiUrl: 'http://api:3001',
      secret: 'shipped-secret',
      log: (message) => logged.push(message),
      fetchImpl: async (input, init) => {
        seenUrl = String(input);
        seenSecret = String((init?.headers as Record<string, string>)['x-internal-secret']);
        return new Response(JSON.stringify({ walletsChecked: 7, mismatches: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(seenUrl).toBe('http://api:3001/v1/internal/coins/reconcile');
    expect(seenSecret).toBe('shipped-secret');
    expect(result).toEqual({ walletsChecked: 7, mismatches: 2 });
    expect(logged.some((line) => line.includes('7'))).toBe(true);
    expect(logged.some((line) => line.includes('2'))).toBe(true);
  });

  it('logs a refusal instead of pretending it reconciled anything', async () => {
    const logged: string[] = [];

    const result = await reconcileCoinWallets({
      apiUrl: 'http://api:3001',
      secret: '',
      log: (message) => logged.push(message),
      fetchImpl: async () => new Response('', { status: 404 }),
    });

    expect(result).toBeNull();
    expect(logged.some((line) => line.includes('could not run'))).toBe(true);
  });

  it('gives the API a full minute before giving up', () => {
    expect(COIN_RECONCILIATION_TIMEOUT_MS).toBe(60_000);
  });
});
