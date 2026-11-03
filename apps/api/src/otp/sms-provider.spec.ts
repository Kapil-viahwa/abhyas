import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FakeSmsProvider,
  HttpSmsProvider,
  SmsDeliveryError,
  createSmsProvider,
  destinationHash,
  renderSmsBody,
  type HttpSmsConfig,
} from './sms-provider';

const MESSAGE = { to: '+919876543210', body: 'Your Abhyas code is 123456', templateId: 'TPL-1' };

/** A local gateway that records one request and answers with the given status and body. */
async function mockGateway(
  status: number,
  payload: unknown,
): Promise<{ server: Server; url: string; received: Array<{ headers: Record<string, unknown>; body: string }> }> {
  const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(address.port)}/send`, received };
}

function config(overrides: Partial<HttpSmsConfig> = {}): HttpSmsConfig {
  return {
    name: 'gateway',
    url: 'http://127.0.0.1:1/send',
    authHeaderName: 'x-api-key',
    authHeaderValue: 'test-key',
    bodyTemplate: '{"to":"{{to}}","message":"{{body}}","template":"{{templateId}}"}',
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe('sms provider', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('builds no provider at all when OTP is disabled', () => {
    // The master switch, at the seam: there is no object to send with, in any environment.
    expect(createSmsProvider({ otpEnabled: false, nodeEnv: 'test', kind: 'fake', http: null })).toBeNull();
    expect(createSmsProvider({ otpEnabled: false, nodeEnv: 'production', kind: 'http', http: config() })).toBeNull();
  });

  it('records a fake message in its outbox and hands back an id', async () => {
    const provider = new FakeSmsProvider('test');

    const result = await provider.send(MESSAGE);

    expect(result.providerMessageId).toMatch(/^fake-/);
    expect(provider.outbox).toHaveLength(1);
    expect(provider.lastTo('+919876543210')?.body).toContain('123456');
    // The whitelist's one job: a number that was never messaged has nothing.
    expect(provider.lastTo('+919000000000')).toBeUndefined();
  });

  it('refuses to exist in production', () => {
    expect(() => new FakeSmsProvider('production')).toThrow(/cannot be used in production/);
    expect(() => createSmsProvider({ otpEnabled: true, nodeEnv: 'production', kind: 'fake', http: null })).toThrow(
      SmsDeliveryError,
    );
  });

  it('fills the body template with escaped values, so the document stays JSON', () => {
    const body = renderSmsBody(config().bodyTemplate, {
      to: '+919876543210',
      body: 'quote " and brace } stay inside the string',
      templateId: 'TPL-1',
    });

    expect(() => JSON.parse(body) as unknown).not.toThrow();
    expect(body).toContain('\\"');
    expect(JSON.parse(body)).toMatchObject({ to: '+919876543210', template: 'TPL-1' });
  });

  it('posts the rendered body and the auth header to the gateway', async () => {
    const gateway = await mockGateway(200, { id: 'msg-42' });
    servers.push(gateway.server);
    const provider = new HttpSmsProvider(config({ url: gateway.url }));

    const result = await provider.send(MESSAGE);

    expect(result.providerMessageId).toBe('msg-42');
    expect(gateway.received).toHaveLength(1);
    expect(gateway.received[0]?.headers['x-api-key']).toBe('test-key');
    expect(JSON.parse(gateway.received[0]?.body ?? '{}')).toMatchObject({
      to: '+919876543210',
      template: 'TPL-1',
    });
  });

  it('turns a gateway error into a delivery error, not a crash', async () => {
    const gateway = await mockGateway(502, { error: 'upstream' });
    servers.push(gateway.server);
    const provider = new HttpSmsProvider(config({ url: gateway.url }));

    await expect(provider.send(MESSAGE)).rejects.toThrow(/answered 502/);
  });

  it('abandons a gateway that never answers', async () => {
    const provider = new HttpSmsProvider(config({ url: 'http://127.0.0.1:1/send', timeoutMs: 50 }));

    await expect(provider.send(MESSAGE)).rejects.toThrow(/could not be reached|timed out/);
  });

  it('hashes a destination so a phone number is never stored in the ledger', () => {
    const first = destinationHash('+919876543210', 'secret-a');
    const again = destinationHash('+919876543210', 'secret-a');
    const other = destinationHash('+919876543211', 'secret-a');
    const differentSecret = destinationHash('+919876543210', 'secret-b');

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(differentSecret).not.toBe(first);
  });
});
