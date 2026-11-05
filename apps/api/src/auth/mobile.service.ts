import { ConflictException, ForbiddenException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { CoinService } from '../coins/coin.service';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { nationalDigits } from '../otp/otp-code';
import { OtpService } from '../otp/otp.service';
import { writeIdentityAudit } from './audit';
import { hashPassword } from './password';
import type { RequestMetadata } from './request';
import { SESSIONS_SERVICE, type IssuedSession, type SessionsService } from './sessions.service';
import { parseMobileLoginBody, parseMobileRegisterBody } from './validation';

import type { LoginResult } from './auth.service';

/**
 * Signing up and signing in with a mobile number.
 *
 * The OTP module proves the number and enforces every abuse control; this service only
 * decides what a proven number means here: a new account, or the account that already
 * owns it. A successful sign-in issues exactly the session password sign-in issues, so
 * revocation, refresh rotation and every later audit row behave the same way.
 *
 * The number is stored twice on purpose: `mobile` keeps the ten national digits the
 * identity trigger already normalises, and `first_verified_mobile` keeps E.164 — the
 * second is unique across the platform, so one phone can never end up owning two accounts.
 */

export const MOBILE_ALREADY_REGISTERED_MESSAGE = 'That number already has an account. Sign in instead.';

/**
 * A number nobody has registered. It is said plainly rather than hidden behind a generic
 * refusal: the only person who can reach this answer holds a code sent to that number, and
 * sending them to the sign-up flow is better than leaving them guessing.
 */
export const MOBILE_LOGIN_UNKNOWN_MESSAGE = 'That number is not registered. Create an account first.';

@Injectable()
export class MobileIdentityService {
  private readonly logger = new Logger(MobileIdentityService.name);

  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(SESSIONS_SERVICE) private readonly sessions: SessionsService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(CoinService) private readonly coins: CoinService,
  ) {}

  private get prisma() {
    return this.database.prisma;
  }

  /**
   * A verified SIGNUP code creates the account and signs it in. The session is issued only
   * after the row exists, so a refused insert leaves nobody signed in.
   */
  async register(body: unknown, meta: RequestMetadata = {}): Promise<LoginResult> {
    this.otp.assertEnabled();

    const input = parseMobileRegisterBody(body);
    const { destination } = await this.otp.verifyCode(
      {
        destination: input.destination,
        purpose: 'SIGNUP',
        code: input.code,
      },
      meta,
    );

    const existing = await this.prisma.user.findFirst({
      where: { firstVerifiedMobile: destination },
      select: { id: true },
    });

    if (existing !== null) {
      await writeIdentityAudit(this.prisma, {
        action: 'IDENTITY_MOBILE_REGISTER_REFUSED',
        actorUserId: existing.id,
        entityId: existing.id,
        metadata: { mobile: destination, reason: 'ALREADY_REGISTERED' },
        ip: meta.ip ?? null,
      });
      throw new ConflictException(MOBILE_ALREADY_REGISTERED_MESSAGE);
    }

    const role = await this.prisma.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
    const now = new Date();

    // A mobile-first account has no password to know: the hash is of a random value the
    // platform never reveals, so password sign-in is impossible until a password is set.
    // Decision 0049 records why an unusable hash is preferable to a nullable column.
    const passwordHash = await hashPassword(randomBytes(32).toString('hex'));

    let userId: string;
    try {
      userId = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: null,
            mobile: nationalDigits(destination),
            firstVerifiedMobile: destination,
            mobileVerifiedAt: now,
            fullName: input.fullName,
            passwordHash,
            roleId: role.id,
          },
          select: { id: true },
        });

        await writeIdentityAudit(tx, {
          action: 'IDENTITY_MOBILE_REGISTERED',
          actorUserId: user.id,
          entityId: user.id,
          metadata: { mobile: destination },
          ip: meta.ip ?? null,
        });

        await tx.domainEvent.create({
          data: { name: 'user.registered', payload: { userId: user.id, roleCode: 'USER' } },
        });

        return user.id;
      });
    } catch (error) {
      // The unique indexes are what actually stop a second account for one number: two
      // registrations arriving together both reach the insert, and only one can win.
      if (!isUniqueViolation(error)) {
        throw error;
      }
      throw new ConflictException(MOBILE_ALREADY_REGISTERED_MESSAGE);
    }

    // A verified mobile is the first verified identifier this account has.
    await this.grantCoinsQuietly(userId);

    return this.signIn(userId, null, 'USER', meta);
  }

  /** A verified LOGIN code signs the account that owns the number in. */
  async login(body: unknown, meta: RequestMetadata = {}): Promise<LoginResult> {
    this.otp.assertEnabled();

    const input = parseMobileLoginBody(body);
    const { destination } = await this.otp.verifyCode(
      {
        destination: input.destination,
        purpose: 'LOGIN',
        code: input.code,
      },
      meta,
    );

    const user = await this.prisma.user.findFirst({
      where: { firstVerifiedMobile: destination },
      select: { id: true, email: true, status: true, role: { select: { code: true } } },
    });

    if (user === null) {
      await writeIdentityAudit(this.prisma, {
        action: 'IDENTITY_LOGIN_FAILED',
        entityId: null,
        metadata: { reason: 'UNKNOWN_MOBILE', mobile: destination },
        ip: meta.ip ?? null,
      });
      throw new UnauthorizedException(MOBILE_LOGIN_UNKNOWN_MESSAGE);
    }

    if (user.status !== 'ACTIVE') {
      await writeIdentityAudit(this.prisma, {
        action: 'IDENTITY_LOGIN_FAILED',
        actorUserId: user.id,
        entityId: user.id,
        metadata: { reason: 'ACCOUNT_INACTIVE', mobile: destination },
        ip: meta.ip ?? null,
      });
      throw new ForbiddenException('This account is not active. Contact support.');
    }

    return this.signIn(user.id, user.email, user.role.code, meta);
  }

  private async signIn(
    userId: string,
    email: string | null,
    roleCode: string,
    meta: RequestMetadata,
  ): Promise<LoginResult> {
    const issued = await this.sessions.issue(userId, { ip: meta.ip, userAgent: meta.userAgent });

    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });

    await writeIdentityAudit(this.prisma, {
      action: 'IDENTITY_LOGIN_SUCCEEDED',
      actorUserId: userId,
      actorRole: roleCode,
      entityId: userId,
      metadata: { sessionId: issued.sessionId, method: 'MOBILE_OTP' },
      ip: meta.ip ?? null,
    });

    await this.rewardLoginQuietly(userId);

    return toLoginResult(issued, userId, email, roleCode);
  }

  /** Coins must never be the reason a sign-up or a sign-in fails; the ledger makes up for it. */
  private async grantCoinsQuietly(userId: string): Promise<void> {
    try {
      await this.coins.grantSignupCoins(userId);
    } catch (error) {
      this.logger.warn(`Signup coins were not granted for ${userId}: ${String(error)}`);
    }
  }

  private async rewardLoginQuietly(userId: string): Promise<void> {
    try {
      await this.coins.payDailyReward(userId);
    } catch (error) {
      this.logger.warn(`The daily reward was not paid for ${userId}: ${String(error)}`);
    }
  }
}

/** The same shape password sign-in answers with, so the web tier has one response to read. */
function toLoginResult(issued: IssuedSession, id: string, email: string | null, roleCode: string): LoginResult {
  return {
    accessToken: issued.accessToken,
    accessExpiresAt: issued.accessExpiresAt.toISOString(),
    refreshToken: issued.refreshToken,
    refreshExpiresAt: issued.refreshExpiresAt.toISOString(),
    user: { id, email, roleCode },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}
