import { createHmac, randomUUID } from 'node:crypto';

/**
 * The SMS seam.
 *
 * Nothing above this interface knows which vendor is used, and nothing below it knows what
 * an OTP is: a provider takes a destination, a body and an approved template id, and either
 * returns an id or throws. When `OTP_ENABLED` is false the factory returns `null` rather
 * than a provider, so no code path in the platform can construct one, let alone send with it.
 */

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

export class SmsDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsDeliveryError';
  }
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

/** Loopback, private, link-local and unique-local addresses, as literals a host may name. */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^0\./,
];

/**
 * The gateway address has to be a public https endpoint in production.
 *
 * Without this, "configure the gateway by environment" is an SSRF seam: a wrong or hostile
 * value would make the API POST an OTP to a host inside our own network. The check is on the
 * literal host, so it needs no DNS at boot — and it refuses rather than silently downgrading.
 */
export function assertGatewayUrl(url: string, nodeEnv: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SmsDeliveryError('The SMS gateway URL is not a valid URL');
  }

  if (nodeEnv !== 'production') {
    return parsed;
  }

  if (parsed.protocol !== 'https:') {
    throw new SmsDeliveryError('The SMS gateway must use https in production');
  }

  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
    throw new SmsDeliveryError('The SMS gateway must not be a private, loopback or link-local address');
  }

  return parsed;
}

/** Fills the template with JSON-escaped values, so the result is always valid JSON. */
export function renderSmsBody(template: string, message: SmsMessage): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = key === 'to' ? message.to : key === 'body' ? message.body : message.templateId;
    // JSON.stringify gives quotes; strip them because the template supplies its own.
    return JSON.stringify(value).slice(1, -1);
  });
}

export class HttpSmsProvider implements SmsProvider {
  readonly name: string;

  constructor(
    private readonly config: HttpSmsConfig,
    private readonly nodeEnv: string = 'development',
  ) {
    assertGatewayUrl(config.url, nodeEnv);
    this.name = config.name;
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.config.authHeaderName !== null && this.config.authHeaderValue !== null) {
        headers[this.config.authHeaderName] = this.config.authHeaderValue;
      }

      const response = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: renderSmsBody(this.config.bodyTemplate, message),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new SmsDeliveryError(`The SMS gateway answered ${String(response.status)}`);
      }

      const payload = (await response.json().catch(() => ({}))) as { id?: unknown; messageId?: unknown };
      const id = payload.id ?? payload.messageId;

      return { providerMessageId: typeof id === 'string' && id !== '' ? id : 'unknown' };
    } catch (error) {
      if (error instanceof SmsDeliveryError) {
        throw error;
      }
      // Never the message, the code or the URL: a delivery error is quoted in logs and
      // alerts, and none of those may carry a live OTP.
      throw new SmsDeliveryError(
        error instanceof Error && error.name === 'AbortError'
          ? 'The SMS gateway timed out'
          : 'The SMS gateway could not be reached',
      );
    } finally {
      clearTimeout(timer);
    }
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

/**
 * The destination hash used in every row, log line and audit record: a phone number must
 * not be readable from the platform's own history.
 */
export function destinationHash(destination: string, secret: string): string {
  return createHmac('sha256', secret).update(destination).digest('hex');
}
