import { createHmac, randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { SmsDeliveryError } from './errors';
import { BlockedAddressError, assertGatewayUrl, resolvePublicAddress, type DnsLookup, type DnsRecord } from './ssrf-guard';

/**
 * The SMS seam.
 *
 * Nothing above this interface knows which vendor is used, and nothing below it knows what
 * an OTP is: a provider takes a destination, a body and an approved template id, and either
 * returns an id or throws. When `OTP_ENABLED` is false the factory returns `null` rather
 * than a provider, so no code path in the platform can construct one, let alone send with it.
 */

export { BlockedAddressError, SmsDeliveryError };

export interface SmsMessage {
  /** E.164, already normalised. */
  readonly to: string;
  readonly body: string;
  /** The DLT-approved template this body was rendered from. */
  readonly templateId: string;
}

export interface SmsSendResult {
  readonly providerMessageId: string;
}

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
}

/** A message the fake provider accepted, kept so a development run can read the code. */
export interface FakeSmsMessage extends SmsMessage {
  readonly providerMessageId: string;
  readonly sentAt: Date;
}

/**
 * The development and CI provider: an in-memory outbox and nothing else. It refuses to be
 * constructed in production at all, so "fake SMS in production" is a boot failure rather
 * than a configuration mistake.
 */
export class FakeSmsProvider implements SmsProvider {
  readonly name = 'fake';
  readonly outbox: FakeSmsMessage[] = [];

  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new SmsDeliveryError('The fake SMS provider cannot be used in production');
    }
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const providerMessageId = `fake-${randomUUID()}`;
    this.outbox.push({ ...message, providerMessageId, sentAt: new Date() });
    return { providerMessageId };
  }

  /** The newest message for a destination, or undefined. Used by tests and dev tooling. */
  lastTo(destination: string): FakeSmsMessage | undefined {
    return this.outbox.filter((entry) => entry.to === destination).at(-1);
  }
}

/**
 * A generic HTTP gateway: the shape almost every Indian SMS vendor exposes. The body is a
 * JSON template with `{{to}}`, `{{body}}` and `{{templateId}}` placeholders, each replaced
 * with a JSON-escaped string, so an author cannot break out of the document.
 */
export interface HttpSmsConfig {
  readonly name: string;
  readonly url: string;
  readonly authHeaderName: string | null;
  readonly authHeaderValue: string | null;
  readonly bodyTemplate: string;
  readonly timeoutMs: number;
}

const PLACEHOLDER = /\{\{(to|body|templateId)\}\}/g;

/** A gateway's answer is a message id; nothing legitimate is anywhere near this large. */
export const MAX_SMS_RESPONSE_BYTES = 8 * 1024;

/** Fills the template with JSON-escaped values, so the result is always valid JSON. */
export function renderSmsBody(template: string, message: SmsMessage): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = key === 'to' ? message.to : key === 'body' ? message.body : message.templateId;
    // JSON.stringify gives quotes; strip them because the template supplies its own.
    return JSON.stringify(value).slice(1, -1);
  });
}

function readJsonId(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) {
      return 'unknown';
    }
    const { id, messageId } = parsed as { id?: unknown; messageId?: unknown };
    const value = id ?? messageId;
    return typeof value === 'string' && value !== '' ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

export class HttpSmsProvider implements SmsProvider {
  readonly name: string;
  private readonly target: URL;

  constructor(
    private readonly config: HttpSmsConfig,
    private readonly nodeEnv: string = 'development',
    private readonly lookup: DnsLookup | undefined = undefined,
  ) {
    this.target = assertGatewayUrl(config.url, nodeEnv);
    this.name = config.name;
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    // Resolved and checked once, then pinned into the connection below: a second lookup
    // could answer with a different address, and that address would never be checked.
    const address = await resolvePublicAddress(
      this.target.hostname,
      this.lookup === undefined ? { nodeEnv: this.nodeEnv } : { nodeEnv: this.nodeEnv, lookup: this.lookup },
    );

    const response = await this.post(renderSmsBody(this.config.bodyTemplate, message), address);

    // Redirects are not followed: a 3xx is outside 2xx and therefore a failure, so the
    // gateway cannot bounce the request into our own network.
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new SmsDeliveryError(`The SMS gateway answered ${String(response.statusCode)}`);
    }

    return { providerMessageId: readJsonId(response.body) };
  }

  private post(body: string, address: DnsRecord): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const isHttps = this.target.protocol === 'https:';
      const defaultPort = isHttps ? 443 : 80;
      const port = this.target.port === '' ? defaultPort : Number(this.target.port);

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        accept: 'application/json',
      };
      if (this.config.authHeaderName !== null && this.config.authHeaderValue !== null) {
        headers[this.config.authHeaderName] = this.config.authHeaderValue;
      }

      const options: RequestOptions = {
        method: 'POST',
        hostname: this.target.hostname,
        port,
        path: `${this.target.pathname}${this.target.search}`,
        headers,
        // The pinned answer: the connection goes to the address that was checked, and
        // Node's own resolver is never consulted again for this request.
        lookup: (_hostname, lookupOptions, callback) => {
          // Node asks for every answer (`all: true`) on the family-selection path and for
          // one on the plain path; both shapes answer with the checked address, never a
          // fresh lookup.
          if (lookupOptions.all === true) {
            callback(null, [{ address: address.address, family: address.family }], address.family);
            return;
          }
          callback(null, address.address, address.family);
        },
      };

      const onResponse = (response: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;

        const fail = (error: Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        };

        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_SMS_RESPONSE_BYTES) {
            // A bounded read: a gateway that streams megabytes is a broken one, and the
            // process will not hold them in memory waiting to find out.
            response.destroy();
            fail(new SmsDeliveryError('The SMS gateway answered with too much data'));
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });

        response.on('error', () => {
          fail(new SmsDeliveryError('The SMS gateway could not be reached'));
        });
      };

      const request = isHttps
        ? httpsRequest({ ...options, servername: this.target.hostname }, onResponse)
        : httpRequest(options, onResponse);

      request.setTimeout(this.config.timeoutMs, () => {
        request.destroy(new Error('sms-timeout'));
      });

      request.on('error', (error: Error) => {
        // Never the message, the code or the URL: a delivery error is quoted in logs and
        // alerts, and none of those may carry a live OTP.
        reject(
          new SmsDeliveryError(
            error.message === 'sms-timeout' ? 'The SMS gateway timed out' : 'The SMS gateway could not be reached',
          ),
        );
      });

      request.end(body);
    });
  }
}

export type SmsProviderKind = 'fake' | 'http';

export interface SmsProviderConfig {
  readonly otpEnabled: boolean;
  readonly nodeEnv: string;
  readonly kind: SmsProviderKind;
  readonly http: HttpSmsConfig | null;
}

/**
 * The one place a provider is built. With OTP off it returns `null`: there is no object to
 * send with, so no route can accidentally deliver a message.
 */
export function createSmsProvider(config: SmsProviderConfig): SmsProvider | null {
  if (!config.otpEnabled) {
    return null;
  }

  if (config.kind === 'fake') {
    return new FakeSmsProvider(config.nodeEnv);
  }

  if (config.http === null) {
    throw new SmsDeliveryError('The HTTP SMS provider needs a gateway configuration');
  }

  return new HttpSmsProvider(config.http, config.nodeEnv);
}

/** The environment keys a provider is built from, so nothing else has to know them. */
export interface SmsEnvConfig {
  readonly OTP_ENABLED: boolean;
  readonly NODE_ENV: string;
  readonly SMS_PROVIDER: string;
  readonly OTP_GATEWAY_URL: string;
  readonly OTP_GATEWAY_AUTH_HEADER: string;
  readonly OTP_GATEWAY_AUTH_VALUE: string;
  readonly OTP_GATEWAY_BODY_TEMPLATE: string;
  readonly OTP_GATEWAY_TIMEOUT_MS: number;
}

/**
 * Builds the provider from validated environment configuration, and only when the switch is
 * on. With `OTP_ENABLED=false` this returns before constructing anything at all — not even a
 * provider that would refuse to send — which is the code-level half of the master switch.
 */
export function providerFromEnv(config: SmsEnvConfig): SmsProvider | null {
  if (!config.OTP_ENABLED) {
    return null;
  }

  if (config.SMS_PROVIDER === 'fake') {
    return createSmsProvider({ otpEnabled: true, nodeEnv: config.NODE_ENV, kind: 'fake', http: null });
  }

  if (config.SMS_PROVIDER !== 'http') {
    throw new SmsDeliveryError(
      `SMS_PROVIDER "${config.SMS_PROVIDER}" has no adapter yet; use "http" with the generic gateway`,
    );
  }

  return createSmsProvider({
    otpEnabled: true,
    nodeEnv: config.NODE_ENV,
    kind: 'http',
    http: {
      name: 'http-gateway',
      url: config.OTP_GATEWAY_URL,
      authHeaderName: config.OTP_GATEWAY_AUTH_HEADER === '' ? null : config.OTP_GATEWAY_AUTH_HEADER,
      authHeaderValue: config.OTP_GATEWAY_AUTH_VALUE === '' ? null : config.OTP_GATEWAY_AUTH_VALUE,
      bodyTemplate: config.OTP_GATEWAY_BODY_TEMPLATE,
      timeoutMs: config.OTP_GATEWAY_TIMEOUT_MS,
    },
  });
}

/** The injection token the API hands the provider (or `null`) over with. */
export const OTP_SMS_PROVIDER = 'OTP_SMS_PROVIDER';

/**
 * The destination hash used in every row, log line and audit record: a phone number must
 * not be readable from the platform's own history.
 */
export function destinationHash(destination: string, secret: string): string {
  return createHmac('sha256', secret).update(destination).digest('hex');
}
