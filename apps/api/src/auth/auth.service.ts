import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { loadConfig } from '../config/config';
import { webUrlFor } from '../config/links';
import { DatabaseService } from '../infra/database.service';
import { EMAIL_SENDER, type EmailSender } from '../infra/email-sender';
import { RATE_LIMITS, RateLimiter, ipRateLimitKey, type RateLimitRule } from '../infra/rate-limiter';
import { DATABASE_PROBE } from '../infra/tokens';
import { TURNSTILE_VERIFIER, type TurnstileVerifier } from '../infra/turnstile-verifier';
import { hashPassword } from './password';
import { EMAIL_TOKEN_TTL_MS, generateToken, hashToken, isExpired } from './tokens';
import { parseEmailToken, parseRegisterBody, type RegisterInput } from './validation';

/**
 * Registration and email verification.
 *
 * Two rules shape every line here:
 * 1. The response never reveals whether an address is already registered, and the
 *    work done before answering is the same in both cases, so timing cannot be
 *    used to find out either.
 * 2. The account, its verification token, the `user.registered` outbox row and
 *    the audit row are written in one transaction: there is no state in which a
 *    user exists without the event that grants their signup coins.
 */

export interface RequestMetadata {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface RegisterResult {
  readonly status: 'PENDING_VERIFICATION';
}

export interface VerifyEmailResult {
  readonly status: 'VERIFIED';
}

/** Identical for an unknown address and an address that already exists. */
export const REGISTER_ACCEPTED: RegisterResult = { status: 'PENDING_VERIFICATION' };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly webUrl: string;

  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(TURNSTILE_VERIFIER) private readonly turnstile: TurnstileVerifier,
    private readonly rateLimiter: RateLimiter,
  ) {
    const config = loadConfig(process.env);
    this.webUrl = webUrlFor(config.NODE_ENV, process.env.WEB_URL);
  }

  private get prisma() {
    return this.database.prisma;
  }

  async register(body: unknown, meta: RequestMetadata = {}): Promise<RegisterResult> {
    const input = parseRegisterBody(body);

    await this.enforceRateLimit([
      { key: ipRateLimitKey('register', meta.ip ?? ''), ...RATE_LIMITS.registerPerIp },
    ]);

    const human = await this.turnstile.verify(input.turnstileToken, meta.ip);
    if (!human) {
      throw new BadRequestException('Human verification failed. Please try again.');
    }

    // Hashed before the lookup on purpose: an existing address and a new one cost
    // the same, so response timing cannot be used to enumerate accounts.
    const passwordHash = await hashPassword(input.password);

    const existing = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, emailVerifiedAt: true },
    });

    if (existing) {
      await this.answerExistingAccount(existing.id, input.email, existing.emailVerifiedAt !== null, meta);
      return REGISTER_ACCEPTED;
    }

    try {
      await this.createAccount(input, passwordHash, meta);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // A concurrent registration for the same address won the insert. Answer the
      // same way, and resend the link so the person can finish the flow.
      const raced = await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
      if (raced) {
        await this.answerExistingAccount(raced.id, input.email, false, meta);
      }
    }

    return REGISTER_ACCEPTED;
  }

  async verifyEmail(body: unknown, meta: RequestMetadata = {}): Promise<VerifyEmailResult> {
    const token = parseEmailToken(body);

    const row = await this.prisma.emailToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, userId: true, purpose: true, expiresAt: true, usedAt: true },
    });

    if (!row || row.purpose !== 'VERIFY_EMAIL' || row.usedAt !== null || isExpired(row.expiresAt)) {
      throw new BadRequestException('This verification link is invalid or has expired.');
    }

    await this.prisma.$transaction(async (tx) => {
      // Single use: the conditional update is what makes a replay impossible even
      // when two requests arrive together.
      const consumed = await tx.emailToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      if (consumed.count !== 1) {
        throw new BadRequestException('This verification link is invalid or has expired.');
      }

      await tx.user.updateMany({
        where: { id: row.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: row.userId,
          actorRole: 'USER',
          action: 'IDENTITY_EMAIL_VERIFIED',
          entityType: 'user',
          entityId: row.userId,
          metadata: {},
          ip: meta.ip ?? null,
        },
      });
    });

    return { status: 'VERIFIED' };
  }

  private async createAccount(input: RegisterInput, passwordHash: string, meta: RequestMetadata): Promise<void> {
    const userRole = await this.prisma.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });

    const token = generateToken();
    const tokenExpiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          fullName: input.fullName,
          passwordHash,
          roleId: userRole.id,
        },
        select: { id: true },
      });

      await tx.emailToken.create({
        data: {
          userId: user.id,
          purpose: 'VERIFY_EMAIL',
          tokenHash: hashToken(token),
          expiresAt: tokenExpiresAt,
          requestIp: meta.ip ?? null,
        },
      });

      // The outbox row is written in the same transaction, so the wallet consumer
      // that grants the signup bonus cannot see one without the other.
      await tx.domainEvent.create({
        data: { name: 'user.registered', payload: { userId: user.id, roleCode: 'USER' } },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: user.id,
          actorRole: 'USER',
          action: 'IDENTITY_USER_REGISTERED',
          entityType: 'user',
          entityId: user.id,
          metadata: { email: input.email },
          ip: meta.ip ?? null,
        },
      });
    });

    await this.sendVerificationEmail(input.email, token, tokenExpiresAt);
  }

  /**
   * An unverified account is sent a fresh link (the first one may never have
   * arrived); a verified one is only audited, so the endpoint cannot be used to
   * mail-bomb an address. Either way the caller sees REGISTER_ACCEPTED.
   */
  private async answerExistingAccount(
    userId: string,
    email: string,
    alreadyVerified: boolean,
    meta: RequestMetadata,
  ): Promise<void> {
    if (alreadyVerified) {
      await this.recordAudit('IDENTITY_REGISTRATION_DUPLICATE', userId, meta, {});
      return;
    }

    const token = generateToken();
    const tokenExpiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      // One live verification link per account: the previous one stops working.
      await tx.emailToken.updateMany({
        where: { userId, purpose: 'VERIFY_EMAIL', usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.emailToken.create({
        data: {
          userId,
          purpose: 'VERIFY_EMAIL',
          tokenHash: hashToken(token),
          expiresAt: tokenExpiresAt,
          requestIp: meta.ip ?? null,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          actorRole: 'USER',
          action: 'IDENTITY_VERIFICATION_RESENT',
          entityType: 'user',
          entityId: userId,
          metadata: { email },
          ip: meta.ip ?? null,
        },
      });
    });

    await this.sendVerificationEmail(email, token, tokenExpiresAt);
  }

  private async recordAudit(
    action: string,
    userId: string,
    meta: RequestMetadata,
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        actorRole: 'USER',
        action,
        entityType: 'user',
        entityId: userId,
        metadata,
        ip: meta.ip ?? null,
      },
    });
  }

  private async sendVerificationEmail(email: string, token: string, expiresAt: Date): Promise<void> {
    const link = `${this.webUrl}/verify-email?token=${encodeURIComponent(token)}`;

    try {
      await this.email.send({
        to: email,
        subject: 'Verify your Abhyas email address',
        text: [
          'Welcome to Abhyas.',
          '',
          'Confirm your email address to finish creating your account:',
          link,
          '',
          `The link is valid until ${expiresAt.toISOString()}.`,
          'If you did not create an account, ignore this message.',
        ].join('\n'),
      });
    } catch (error) {
      // The account exists; a mail outage must not fail the request that created it.
      this.logger.error(`Could not send the verification email: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async enforceRateLimit(rules: readonly RateLimitRule[]): Promise<void> {
    const denial = await this.rateLimiter.consumeAll(rules);

    if (denial) {
      throw new HttpException(
        `Too many attempts. Try again in ${denial.retryAfterSeconds} seconds.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}
