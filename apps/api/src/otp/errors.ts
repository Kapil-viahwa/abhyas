/**
 * The one error type the SMS seam raises, kept in its own module so the SSRF guard can
 * extend it without a circular import between the guard and the provider.
 *
 * Every message is written for an operator: it names the failure, never the destination,
 * the body or the code.
 */
export class SmsDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsDeliveryError';
  }
}
