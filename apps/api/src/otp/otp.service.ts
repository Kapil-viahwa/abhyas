import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { writeIdentityAudit } from '../auth/audit';
import type { RequestMetadata } from '../auth/request';
import { loadConfig } from '../config/config';
import { DatabaseService } from '../infra/database.service';
import { RateLimiter, ipRateLimitKey } from '../infra/rate-limiter';
import { DATABASE_PROBE } from '../infra/tokens';
import { TURNSTILE_VERIFIER, type TurnstileVerifier } from '../infra/turnstile-verifier';
import {
  InvalidMobileError,
  OTP_LIMITS,
  OTP_MAX_ATTEMPTS,
  OTP_SMS_COST,
  OTP_TTL_SECONDS,
  businessDate,
  codeMatches,
  generateCode,
  hashCode,
  isSequentialDigits,
  normaliseMobile,
  otpAlertKey,
  otpBudgetKey,
  otpDeviceLimitKey,
  otpNumberLimitKey,
  resendCooldownSeconds,
  startOfBusinessDay,
} from './otp-code';
import { OTP_SMS_PROVIDER, destinationHash, type SmsProvider } from './sms-provider';

/**
 * The OTP service: one code in, one code out, and every abuse control around them.
 *
 * The shape of the promise to a client is deliberately flat. A request either answers
 * "accepted" — the same body, the same status, the same work whether the number belongs to
 * an account or to nobody — or it is refused by a limit. That is what keeps this endpoint
 * from becoming a membership oracle.
 */

export const OTP_PURPOSES = ['SIGNUP', 'LOGIN', 'LINK'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const OTP_ALERTS = {
  requestLimited: 'OTP_REQUEST_LIMITED',
  sendFailed: 'OTP_SEND_FAILED',
  budgetExhausted: 'SMS_BUDGET_EXHAUSTED',
  anomaly: 'OTP_ANOMALY_DETECTED',
} as const;

/** A refusal that carries how long the client should wait, so the route can set `retry-after`. */
export class OtpThrottledException extends HttpException {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
    this.name = 'OtpThrottledException';
  }
}

export function parseOtpPurpose(value: unknown): OtpPurpose {
  const purpose = typeof value === 'string' ? value.trim().toUpperCase() : '';

  if (!OTP_PURPOSES.includes(purpose as OtpPurpose)) {
    throw new BadRequestException('The OTP purpose is not valid');
  }

  return purpose as OtpPurpose;
}

export interface OtpRequestInput {
  readonly destination: string;
  readonly purpose: OtpPurpose | string;
  readonly turnstileToken: string;
  readonly deviceId?: string | undefined;
}

export interface OtpRequestResult {
  readonly status: 'accepted';
  /** How long before another resend is worth asking for. */
  readonly resendAfterSeconds: number;
}

export interface OtpVerifyInput {
  readonly destination: string;
  readonly purpose: OtpPurpose | string;
  readonly code: string;
  readonly deviceId?: string | undefined;
}

export interface OtpVerifyResult {
  /** E.164, normalised. The caller resolves the account; this service never does. */
  readonly destination: string;
}

interface OtpRow {
  readonly id: string;
  readonly codeHmac: string;
  readonly attempts: number;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly enabled: boolean;
  private readonly hmacSecret: string;
  private readonly allowedCountryCodes: readonly string[];
  private readonly dailyBudget: number;
  private readonly templateId: string;

  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(TURNSTILE_VERIFIER) private readonly turnstile: TurnstileVerifier,
    @Inject(OTP_SMS_PROVIDER) private readonly provider: SmsProvider | null,
  ) {
    const config = loadConfig(process.env);
    this.enabled = config.OTP_ENABLED;
    this.hmacSecret = config.OTP_HMAC_SECRET;
    this.allowedCountryCodes = config.OTP_ALLOWED_COUNTRY_CODES;
    this.dailyBudget = config.OTP_SMS_DAILY_BUDGET;
    this.templateId = config.OTP_TEMPLATE_ID;
  }

  private get prisma() {
    return this.database.prisma;
  }

  /**
   * The master switch, at the service boundary. Every entry point calls this first: with OTP
   * off the platform answers 404, exactly as if these routes had never been deployed.
   */
  assertEnabled(): void {
    if (!this.enabled) {
      throw new NotFoundException('Not found');
    }
  }

  async requestCode(input: OtpRequestInput, meta: RequestMetadata = {}): Promise<OtpRequestResult> {
    this.assertEnabled();

    const purpose = parseOtpPurpose(input.purpose);
    const destination = this.normalise(input.destination);
    const now = new Date();

    // No code leaves for a request that did not pass a human check.
    const token = typeof input.turnstileToken === 'string' ? input.turnstileToken : '';
    if (!(await this.turnstile.verify(token, meta.ip))) {
      throw new BadRequestException('The human verification failed. Please try again.');
    }

    const secret = this.hmacSecret;
    const destinationDigest = destinationHash(destination, secret);
    const ipDigest = meta.ip === undefined || meta.ip.trim() === '' ? null : destinationHash(meta.ip.trim(), secret);
    const deviceDigest =
      input.deviceId === undefined || input.deviceId.trim() === ''
        ? null
        : destinationHash(input.deviceId.trim(), secret);

    const rules = [
      {
        key: otpNumberLimitKey(purpose, destinationDigest, 'hour'),
        limit: OTP_LIMITS.perNumberPerHour,
        windowSeconds: 3600,
      },
      {
        key: otpNumberLimitKey(purpose, destinationDigest, 'day'),
        limit: OTP_LIMITS.perNumberPerDay,
        windowSeconds: 86_400,
      },
      {
        key: ipRateLimitKey('otp-request', meta.ip ?? ''),
        limit: OTP_LIMITS.perIpPerHour,
        windowSeconds: 3600,
      },
      ...(deviceDigest === null
        ? []
        : [
            {
              key: otpDeviceLimitKey(deviceDigest),
              limit: OTP_LIMITS.perDevicePerHour,
              windowSeconds: 3600,
            },
          ]),
    ];

    const denial = await this.limiter.consumeAll(rules);

    if (denial !== null) {
      // A burst from one address, or one number asking far too often, is the anomaly the
      // audit trail should be able to name afterwards.
      await this.recordAlarm(
        OTP_ALERTS.requestLimited,
        { purpose, destinationHash: destinationDigest, ipHash: ipDigest },
        now,
      );
      throw new OtpThrottledException('Too many codes requested. Please try again later.', denial.retryAfterSeconds);
    }

    const recent = await this.prisma.otpRequest.count({
      where: {
        destinationHash: destinationDigest,
        purpose,
        createdAt: { gte: new Date(now.getTime() - 3_600_000) },
      },
    });

    const cooldown = resendCooldownSeconds(recent);
    const last = await this.prisma.otpRequest.findFirst({
      where: { destinationHash: destinationDigest, purpose },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (last !== null) {
      const elapsedSeconds = (now.getTime() - last.createdAt.getTime()) / 1_000;
      if (elapsedSeconds < cooldown) {
        throw new OtpThrottledException(
          'A code was sent moments ago. Please wait before asking for another.',
          Math.max(1, Math.ceil(cooldown - elapsedSeconds)),
        );
      }
    }

    await this.assertBudget(now);

    const code = generateCode();
    const request = await this.prisma.otpRequest.create({
      data: {
        destination,
        destinationHash: destinationDigest,
        purpose,
        codeHmac: hashCode(secret, destination, code),
        attempts: 0,
        expiresAt: new Date(now.getTime() + OTP_TTL_SECONDS * 1_000),
        ipHash: ipDigest,
        deviceHash: deviceDigest,
      },
      select: { id: true },
    });

    try {
      const provider = this.provider;
      if (provider === null) {
        // Unreachable while the switch is on (the factory builds a provider), and a hard
        // stop rather than a silent success if it ever is.
        throw new Error('No SMS provider is configured');
      }

      const sent = await provider.send({
        to: destination,
        body: `Your Abhyas verification code is ${code}. It expires in 5 minutes. Do not share it.`,
        templateId: this.templateId,
      });

      await this.prisma.smsCostLedger.create({
        data: {
          provider: provider.name,
          destinationHash: destinationDigest,
          cost: OTP_SMS_COST,
          providerMessageId: sent.providerMessageId,
        },
      });
    } catch (error) {
      // The row exists, so mark it spent: a code that was never delivered must never verify.
      await this.prisma.otpRequest.update({ where: { id: request.id }, data: { consumedAt: new Date() } });
      await this.recordAlarm(OTP_ALERTS.sendFailed, { purpose }, now);
      this.logger.warn(`OTP delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new ServiceUnavailableException('We could not send a code right now. Please try again.');
    }

    // The code itself is nowhere in this record: only the hash of the destination.
    await writeIdentityAudit(this.prisma, {
      action: 'OTP_REQUESTED',
      entityType: 'otp_request',
      entityId: request.id,
      metadata: { purpose, destinationHash: destinationDigest },
      ip: meta.ip ?? null,
    });

    if (isSequentialDigits(destination)) {
      await this.recordAlarm(OTP_ALERTS.anomaly, { purpose, reason: 'SEQUENTIAL_NUMBER' }, now);
    }

    return { status: 'accepted', resendAfterSeconds: resendCooldownSeconds(recent + 1) };
  }

  async verifyCode(input: OtpVerifyInput): Promise<OtpVerifyResult> {
    this.assertEnabled();

    const purpose = parseOtpPurpose(input.purpose);
    const destination = this.normalise(input.destination);
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    const now = new Date();
    const secret = this.hmacSecret;
    const destinationDigest = destinationHash(destination, secret);

    const request = await this.prisma.otpRequest.findFirst({
      where: { destinationHash: destinationDigest, purpose, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, codeHmac: true, attempts: true },
    });

    if (request === null) {
      // Spend a comparison anyway: an unknown number must not answer measurably faster.
      codeMatches('0'.repeat(64), secret, destination, code);
      throw new BadRequestException('That code is not valid');
    }

    const row: OtpRow = request;

    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await this.consume(row.id, now);
      throw new BadRequestException('That code is not valid');
    }

    if (!codeMatches(row.codeHmac, secret, destination, code)) {
      const attempts = row.attempts + 1;
      await this.prisma.otpRequest.update({
        where: { id: row.id },
        data: { attempts, consumedAt: attempts >= OTP_MAX_ATTEMPTS ? now : null },
      });

      await writeIdentityAudit(this.prisma, {
        action: 'OTP_FAILED',
        entityType: 'otp_request',
        entityId: row.id,
        metadata: { purpose, destinationHash: destinationDigest, attempts },
      });

      throw new BadRequestException('That code is not valid');
    }

    // One winner: a second verifier using the same code finds it already consumed.
    const consumed = await this.prisma.otpRequest.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: now },
    });

    if (consumed.count === 0) {
      throw new BadRequestException('That code is not valid');
    }

    await writeIdentityAudit(this.prisma, {
      action: 'OTP_VERIFIED',
      entityType: 'otp_request',
      entityId: row.id,
      metadata: { purpose, destinationHash: destinationDigest },
    });

    return { destination };
  }

  /** How many times an alert has fired for a business day. Exposed for operators and tests. */
  async alertCount(action: string, now: Date = new Date()): Promise<number> {
    return this.limiter.count(otpAlertKey(action, businessDate(now)));
  }

  private normalise(value: unknown): string {
    try {
      return normaliseMobile(typeof value === 'string' ? value : '', this.allowedCountryCodes);
    } catch (error) {
      if (error instanceof InvalidMobileError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private async consume(id: string, now: Date): Promise<void> {
    await this.prisma.otpRequest.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: now } });
  }

  /**
   * The daily budget, as a hard stop. The ledger is the count (one row per message actually
   * handed to a provider), and the breaker is latched in Redis for the rest of the business
   * day so a flood of requests cannot turn into a flood of queries.
   */
  private async assertBudget(now: Date): Promise<void> {
    const day = businessDate(now);
    const breakerKey = otpBudgetKey(day);

    if ((await this.limiter.count(breakerKey)) > 0) {
      throw new ServiceUnavailableException('Codes are paused for today. Please try again tomorrow.');
    }

    const start = startOfBusinessDay(now);
    const end = new Date(start.getTime() + 86_400_000);
    const sent = await this.prisma.smsCostLedger.count({ where: { createdAt: { gte: start, lt: end } } });

    if (sent >= this.dailyBudget) {
      await this.limiter.hit(breakerKey, 86_400);
      await this.recordAlarm(OTP_ALERTS.budgetExhausted, { day, budget: this.dailyBudget }, now);
      throw new ServiceUnavailableException('Codes are paused for today. Please try again tomorrow.');
    }
  }

  /**
   * An alert: one audit row naming the action and how many times it has fired today, plus a
   * Redis counter an operator (and a test) can read without touching the audit table.
   */
  private async recordAlarm(action: string, metadata: Prisma.InputJsonObject, now: Date): Promise<number> {
    const count = await this.limiter.hit(otpAlertKey(action, businessDate(now)), 86_400);

    await writeIdentityAudit(this.prisma, {
      action: 'OTP_ALERT',
      entityType: 'otp_alert',
      entityId: action,
      metadata: { alert: action, count, ...metadata },
    });

    this.logger.warn(`OTP alert ${action} (${String(count)} today)`);
    return count;
  }
}
