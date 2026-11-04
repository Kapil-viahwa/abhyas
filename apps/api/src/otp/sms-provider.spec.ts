import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FakeSmsProvider,
  HttpSmsProvider,
  MAX_SMS_RESPONSE_BYTES,
  SmsDeliveryError,
  createSmsProvider,
  destinationHash,
  providerFromEnv,
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
    const provider = new HttpSmsProvider(config({ url: 'http://127.0.0.1:1/send', timeoutMs: 50 }), 'test');

    await expect(provider.send(MESSAGE)).rejects.toThrow(/could not be reached|timed out/);
  });

  it('refuses a gateway that is not https in production', () => {
    expect(() => new HttpSmsProvider(config({ url: 'http://sms.example.com/send' }), 'production')).toThrow(
      /must use https in production/,
    );
    expect(() => new HttpSmsProvider(config({ url: 'https://sms.example.com/send' }), 'production')).not.toThrow();
  });

  it('refuses a private, loopback or link-local gateway in production', () => {
    for (const url of [
      'https://localhost/send',
      'https://127.0.0.1/send',
      'https://10.0.0.5/send',
      'https://192.168.1.10/send',
      'https://169.254.169.254/latest/meta-data',
      'https://172.16.0.9/send',
      'https://[::1]/send',
    ]) {
      expect(() => new HttpSmsProvider(config({ url }), 'production'), url).toThrow(/private, loopback or link-local/);
    }
  });

  it('refuses to build the HTTP provider at production boot with an unsafe gateway', () => {
    // The boot-refusal: turning OTP on in production with a bad URL stops the process.
    expect(() =>
      createSmsProvider({
        otpEnabled: true,
        nodeEnv: 'production',
        kind: 'http',
        http: config({ url: 'http://10.1.2.3/send' }),
      }),
    ).toThrow(SmsDeliveryError);
  });

  it('never writes the code or the body to a log, even when delivery fails', async () => {
    const captured: string[] = [];
    const record = (...parts: unknown[]): void => {
      captured.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
    };
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    console.log = record;
    console.warn = record;
    console.error = record;
    console.info = record;

    try {
      const provider = new HttpSmsProvider(config({ url: 'http://127.0.0.1:1/send', timeoutMs: 30 }), 'test');
      await expect(provider.send({ ...MESSAGE, body: 'Your Abhyas code is 654321' })).rejects.toThrow();
    } finally {
      Object.assign(console, original);
    }

    const everything = captured.join('\n');
    expect(everything).not.toContain('654321');
    expect(everything).not.toContain('Your Abhyas code');
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

  it('refuses a redirect instead of following it', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: 'http://127.0.0.1:1/steal' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const provider = new HttpSmsProvider(config({ url: `http://127.0.0.1:${String(address.port)}/send` }), 'test');

    await expect(provider.send(MESSAGE)).rejects.toThrow(/answered 302/);
  });

  it('refuses an answer larger than the response cap', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'x', padding: 'a'.repeat(MAX_SMS_RESPONSE_BYTES * 2) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const provider = new HttpSmsProvider(config({ url: `http://127.0.0.1:${String(address.port)}/send` }), 'test');

    await expect(provider.send(MESSAGE)).rejects.toThrow(/too much data/);
  });

  it('connects to the address the resolver returned, never a second lookup', async () => {
    const gateway = await mockGateway(200, { id: 'msg-pinned' });
    servers.push(gateway.server);
    const port = new URL(gateway.url).port;

    let lookups = 0;
    const provider = new HttpSmsProvider(
      // A name that cannot resolve: only the pinned answer can reach the mock gateway.
      config({ url: `http://sms.invalid:${port}/send` }),
      'test',
      async () => {
        lookups += 1;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    );

    const result = await provider.send(MESSAGE);

    expect(result.providerMessageId).toBe('msg-pinned');
    expect(lookups).toBe(1);
  });

  it('refuses an IPv4-mapped IPv6 and a numeric host in production', () => {
    for (const url of ['https://[::ffff:127.0.0.1]/send', 'https://2130706433/send', 'https://[fd00::1]/send']) {
      expect(() => new HttpSmsProvider(config({ url }), 'production'), url).toThrow(/private, loopback or link-local/);
    }
  });

  it('never constructs a provider when the switch is off, even with a broken gateway', () => {
    // The URL is not even a URL: nothing was looked at, because the switch is checked first.
    expect(
      providerFromEnv({
        OTP_ENABLED: false,
        NODE_ENV: 'production',
        SMS_PROVIDER: 'http',
        OTP_GATEWAY_URL: 'not a url',
        OTP_GATEWAY_AUTH_HEADER: '',
        OTP_GATEWAY_AUTH_VALUE: '',
        OTP_GATEWAY_BODY_TEMPLATE: '',
        OTP_GATEWAY_TIMEOUT_MS: 5000,
      }),
    ).toBeNull();
  });

  it('builds the gateway from the environment when the switch is on', () => {
    const provider = providerFromEnv({
      OTP_ENABLED: true,
      NODE_ENV: 'test',
      SMS_PROVIDER: 'http',
      OTP_GATEWAY_URL: 'https://sms.example.com/send',
      OTP_GATEWAY_AUTH_HEADER: 'x-api-key',
      OTP_GATEWAY_AUTH_VALUE: 'key',
      OTP_GATEWAY_BODY_TEMPLATE: '{"to":"{{to}}"}',
      OTP_GATEWAY_TIMEOUT_MS: 2000,
    });

    expect(provider?.name).toBe('http-gateway');
  });

  it('refuses a provider that has no adapter yet instead of sending nothing', () => {
    expect(() =>
      providerFromEnv({
        OTP_ENABLED: true,
        NODE_ENV: 'production',
        SMS_PROVIDER: 'msg91',
        OTP_GATEWAY_URL: 'https://sms.example.com/send',
        OTP_GATEWAY_AUTH_HEADER: '',
        OTP_GATEWAY_AUTH_VALUE: '',
        OTP_GATEWAY_BODY_TEMPLATE: '{"to":"{{to}}"}',
        OTP_GATEWAY_TIMEOUT_MS: 5000,
      }),
    ).toThrow(/no adapter yet/);
  });
});
