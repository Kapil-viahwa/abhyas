import { describe, expect, it } from 'vitest';

import { ConsoleEmailSender, EmailDeliveryError, SmtpEmailSender, createEmailSender } from './email-sender';

const message = { to: 'student@example.com', subject: 'Verify your email', text: 'https://example.test/verify' };

describe('email sender', () => {
  it('prints the message to the outbox in development and CI', async () => {
    const sender = new ConsoleEmailSender('test');

    await expect(sender.send(message)).resolves.toBeUndefined();
  });

  it('refuses the console outbox in production', () => {
    expect(() => new ConsoleEmailSender('production')).toThrow(EmailDeliveryError);
    expect(() => new ConsoleEmailSender('production')).toThrow(/console email outbox is refused in production/);
  });

  it('refuses an smtp sender with no SMTP_URL, so a production boot cannot silently drop mail', () => {
    expect(() => new SmtpEmailSender(undefined)).toThrow(EmailDeliveryError);
    expect(() => new SmtpEmailSender('   ')).toThrow(/requires SMTP_URL/);
  });

  it('fails loudly instead of pretending the smtp stub delivered', async () => {
    const sender = new SmtpEmailSender('smtp://user:secret@smtp.example.com:587');

    await expect(sender.send(message)).rejects.toThrow(/not wired/);
  });

  it('selects the implementation from EMAIL_PROVIDER and never allows the console one in production', () => {
    expect(createEmailSender('console', 'development', undefined)).toBeInstanceOf(ConsoleEmailSender);
    expect(() => createEmailSender('console', 'production', undefined)).toThrow(EmailDeliveryError);
    expect(createEmailSender('smtp', 'production', 'smtp://smtp.example.com:587')).toBeInstanceOf(SmtpEmailSender);
  });
});
