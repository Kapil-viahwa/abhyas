import { Logger } from '@nestjs/common';

import type { EmailProvider, NodeEnv } from '@abhyas/shared';

/**
 * The one seam that delivers mail. Nothing in the API talks to a mail provider
 * directly, so the outbox used in development and CI cannot leak into production:
 * the console sender refuses to be constructed there, and `validateEnv` refuses
 * `EMAIL_PROVIDER=console` before the process even gets this far.
 */
export const EMAIL_SENDER = 'EMAIL_SENDER';

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface EmailSender {
  send(email: OutgoingEmail): Promise<void>;
}

export class EmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

export interface CapturedEmail extends OutgoingEmail {
  readonly capturedAt: Date;
}

const CAPTURE_LIMIT = 20;
const captured: CapturedEmail[] = [];

/**
 * The last messages the console outbox printed. This is what lets a development
 * run — and the HTTP test — follow the link that was "sent" without a mail server
 * or a test-only bypass of the real path.
 */
export function capturedOutbox(): readonly CapturedEmail[] {
  return captured;
}

export function clearCapturedOutbox(): void {
  captured.length = 0;
}

/**
 * Development, test and CI only. Printing the message is what makes the flow
 * usable locally: the verification link appears in the API log, which is where a
 * developer reads it. The constructor refuses to exist in production.
 */
export class ConsoleEmailSender implements EmailSender {
  private readonly logger = new Logger('EmailOutbox');

  constructor(nodeEnv: NodeEnv) {
    if (nodeEnv === 'production') {
      throw new EmailDeliveryError('The console email outbox is refused in production (EMAIL_PROVIDER=console)');
    }
  }

  async send(email: OutgoingEmail): Promise<void> {
    captured.push({ ...email, capturedAt: new Date() });
    if (captured.length > CAPTURE_LIMIT) {
      captured.splice(0, captured.length - CAPTURE_LIMIT);
    }
    this.logger.log(`to=${email.to} subject="${email.subject}"\n${email.text}`);
  }
}

/**
 * The SMTP stub. It validates its configuration at construction, so a production
 * boot with EMAIL_PROVIDER=smtp but no SMTP_URL fails instead of quietly dropping
 * every verification mail. Delivery itself fails loudly rather than pretending:
 * writing an SMTP client is a dependency decision, and PROGRESS.md lists it as a
 * known gap (decision 0027).
 */
export class SmtpEmailSender implements EmailSender {
  private readonly logger = new Logger(SmtpEmailSender.name);
  private readonly endpoint: string;

  constructor(smtpUrl: string | undefined) {
    const endpoint = (smtpUrl ?? '').trim();
    if (endpoint === '') {
      throw new EmailDeliveryError(
        'EMAIL_PROVIDER=smtp requires SMTP_URL; refusing to start without a mail transport',
      );
    }
    this.endpoint = endpoint;
  }

  async send(email: OutgoingEmail): Promise<void> {
    this.logger.warn(`SMTP delivery is not implemented; message to ${email.to} was not delivered (${redact(this.endpoint)})`);
    throw new EmailDeliveryError('SMTP delivery is not wired in this build: see decision 0027 in docs/decisions.md');
  }
}

/** Never log a connection string: it usually carries credentials. */
function redact(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return 'unparseable SMTP_URL';
  }
}

export function createEmailSender(
  provider: EmailProvider,
  nodeEnv: NodeEnv,
  smtpUrl: string | undefined,
): EmailSender {
  switch (provider) {
    case 'console':
      return new ConsoleEmailSender(nodeEnv);
    case 'smtp':
      return new SmtpEmailSender(smtpUrl);
    default: {
      const unreachable: never = provider;
      throw new EmailDeliveryError(`Unknown email provider: ${String(unreachable)}`);
    }
  }
}
