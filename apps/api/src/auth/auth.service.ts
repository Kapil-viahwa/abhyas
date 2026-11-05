import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { CoinsHooksService } from '../coins/hooks.service';
import { loadConfig } from '../config/config';
import { webUrlFor } from '../config/links';
import { DatabaseService } from '../infra/database.service';
import { EMAIL_SENDER, type EmailSender } from '../infra/email-sender';
import {
  LOGIN_THROTTLE,
  RATE_LIMITS,
  RateLimiter,
  accountRateLimitKey,
  ipRateLimitKey,
  loginDelayMs,
  loginPairKey,
  type RateLimitRule,
} from '../infra/rate-limiter';
import { DATABASE_PROBE } from '../infra/tokens';
import { TURNSTILE_VERIFIER, type TurnstileVerifier } from '../infra/turnstile-verifier';
import type { AuthenticatedUser } from './access';
import { writeIdentityAudit } from './audit';
import { isDisposableEmail } from './disposable-email';
import { hashPassword, verifyPassword } from './password';
import type { RequestMetadata } from './request';
import { RefreshTokenReuseError, SESSIONS_SERVICE, type SessionsService } from './sessions.service';
import { EMAIL_TOKEN_TTL_MS, generateToken, hashToken, isExpired } from './tokens';
import {
  parseEmailToken,
  parseForgotPasswordBody,
  parseLoginBody,
  parseRefreshBody,
  parseRegisterBody,
  parseResetPasswordBody,
  type RegisterInput,
} from './validation';

export type { RequestMetadata };

/**
 * Registration, verification, sign-in and the session lifecycle.
 *
 * Three rules shape every line here:
 * 1. A response never reveals whether an address is registered, and the work done
 *    before answering is the same either way, so timing cannot be used to find out.
 * 2. Anything that changes a credential — password change, reset, deactivation, role
 *    change — ends the sessions it must, in the same transaction as the change.
 * 3. Sign-in throttling slows the guesser and never locks the owner out: the highest
 *    counter asks for a human check, and the person who knows the password can pass it.
 */


export interface RegisterResult {
  readonly status: 'PENDING_VERIFICATION';
}

export interface VerifyEmailResult {
  readonly status: 'VERIFIED';
}

/** Identical for an unknown address and an address that already exists. */
export const REGISTER_ACCEPTED: RegisterResult = { status: 'PENDING_VERIFICATION' };

export interface LoginResult {
  readonly accessToken: string;
  readonly accessExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
  readonly user: {
    readonly id: string;
    /** Null for an account created with a mobile number and no email yet. */
    readonly email: string | null;
    readonly roleCode: string;
  };
}

export interface LogoutResult {
  readonly status: 'SIGNED_OUT';
}

/** The pair a client receives on sign-in and again on every refresh rotation. */
export interface RefreshResult {
  readonly accessToken: string;
  readonly accessExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
}

export interface ForgotPasswordResult {
  readonly status: 'RESET_REQUESTED';
}

export interface ResetPasswordResult {
  readonly status: 'PASSWORD_RESET';
}

/** Identical for an address that exists and one that never did. */
export const RESET_REQUESTED: ForgotPasswordResult = { status: 'RESET_REQUESTED' };

/** Identical for an unknown address and a wrong password. */
export const LOGIN_FAILURE_MESSAGE = 'Email or password is incorrect.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly webUrl: string;

  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(TURNSTILE_VERIFIER) private readonly turnstile: TurnstileVerifier,
    @Inject(SESSIONS_SERVICE) private readonly sessions: SessionsService,
    // Injected by token, so the container never has to infer it from metadata.
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
    @Inject(CoinsHooksService) private readonly coins: CoinsHooksService,
  ) {
    const config = loadConfig(process.env);
    this.webUrl = webUrlFor(config.NODE_ENV, process.env.WEB_URL);
  }

  private get prisma() {
    return this.database.prisma;
  }

  async register(body: unknown, meta: RequestMetadata = {}): Promise<RegisterResult> {
    const input = parseRegisterBody(body);

    // The signup grant is once per person, so a throwaway inbox must not earn one. This is
    // checked before the human verification on purpose: it costs nothing and no SMS or
    // mail is sent for a request that is going to be refused anyway.
    if (isDisposableEmail(input.email)) {
      throw new BadRequestException('Use a permanent email address: throwaway inboxes are not accepted.');
    }

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

    // The identifier the setting names has just been verified, so this is the moment the
    // signup grant is due. It is idempotent (the key is the account), so a replay, a second
    // verification and a backfill that runs afterwards all change nothing.
    await this.grantCoinsQuietly(row.userId);

    return { status: 'VERIFIED' };
  }

  async login(body: unknown, meta: RequestMetadata = {}): Promise<LoginResult> {
    const input = parseLoginBody(body);
    const ip = meta.ip ?? '';

    // Per host only. A shared office address cannot guess its way into a lock for
    // everybody behind it, and no key here is global to an account.
    await this.enforceRateLimit([{ key: ipRateLimitKey('login', ip), ...RATE_LIMITS.loginPerIp }]);

    const pairKey = loginPairKey(input.email, ip);
    const accountKey = accountRateLimitKey('login', input.email);

    // The address + account pair is refused at its own ceiling, so one host cannot
    // keep guessing. Every other address for that account is a different key.
    const pairFailures = await this.rateLimiter.count(pairKey);
    if (pairFailures >= RATE_LIMITS.loginPair.limit) {
      throw new HttpException(
        'Too many attempts for this account from this address. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Slow the guesser before the password is even compared, and make only the
    // address that is guessing pay for it.
    await sleep(loginDelayMs(pairFailures));

    // A high number of failures anywhere for this account asks for a fresh human
    // check instead of a lock: the owner passes it and is in, an attacker cannot
    // turn the counter into a denial of service.
    const accountFailures = await this.rateLimiter.count(accountKey);
    if (accountFailures >= LOGIN_THROTTLE.accountChallengeThreshold) {
      const challengeToken = input.turnstileToken;
      const human = challengeToken !== undefined && (await this.turnstile.verify(challengeToken, meta.ip));

      if (!human) {
        // The refused attempt still counts against this address + account pair: the
        // address failed to produce a challenge token, and it is the address that
        // pays for it — never the account.
        await this.rateLimiter.hit(pairKey, RATE_LIMITS.loginPair.windowSeconds);

        throw new UnauthorizedException({
          statusCode: HttpStatus.UNAUTHORIZED,
          message: LOGIN_FAILURE_MESSAGE,
          error: 'Unauthorized',
          challengeRequired: true,
        });
      }
    }

    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
        emailVerifiedAt: true,
        role: { select: { code: true } },
      },
    });

    if (!user) {
      // Verifying against a throwaway hash costs what a real check costs, so the
      // response time does not say whether the address exists.
      await verifyPassword(await dummyHash(), input.password);
      await this.recordLoginFailure(null, input.email, 'UNKNOWN_ACCOUNT', meta, { pairKey, accountKey });
      throw new UnauthorizedException(LOGIN_FAILURE_MESSAGE);
    }

    const passwordMatches = await verifyPassword(user.passwordHash, input.password);
    if (!passwordMatches) {
      await this.recordLoginFailure(user.id, input.email, 'BAD_PASSWORD', meta, { pairKey, accountKey });
      throw new UnauthorizedException(LOGIN_FAILURE_MESSAGE);
    }

    // Only reached with the correct password, so neither message below tells
    // anyone anything they could not already prove.
    if (user.status !== 'ACTIVE') {
      await this.recordLoginFailure(user.id, input.email, 'ACCOUNT_INACTIVE', meta);
      throw new ForbiddenException('This account is not active. Contact support.');
    }

    if (user.emailVerifiedAt === null) {
      throw new ForbiddenException('Verify your email address before signing in.');
    }

    // Correct credentials: this address has earned its way past the counters, so the
    // failures that came before it no longer count against the person.
    await this.rateLimiter.reset(pairKey);
    await this.rateLimiter.reset(accountKey);

    const issued = await this.sessions.issue(user.id, { ip: meta.ip, userAgent: meta.userAgent });

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.recordAudit(
      'IDENTITY_LOGIN_SUCCEEDED',
      user.id,
      meta,
      { sessionId: issued.sessionId },
      user.role.code,
    );

    // A grant that failed at verification heals on the next sign-in, before the reward needs
    // a wallet to pay into.
    await this.grantCoinsQuietly(user.id);
    await this.rewardLoginQuietly(user.id);

    return {
      accessToken: issued.accessToken,
      accessExpiresAt: issued.accessExpiresAt.toISOString(),
      refreshToken: issued.refreshToken,
      refreshExpiresAt: issued.refreshExpiresAt.toISOString(),
      user: { id: user.id, email: user.email, roleCode: user.role.code },
    };
  }

  /**
   * Coins must never be the reason a verification or a sign-in fails: the hook counts and
   * audits a failure and the person carries on.
   */
  private async grantCoinsQuietly(userId: string): Promise<void> {
    await this.coins.grantSafely(userId);
  }

  private async rewardLoginQuietly(userId: string): Promise<void> {
    await this.coins.rewardSafely(userId);
  }

  async logout(user: AuthenticatedUser, meta: RequestMetadata = {}): Promise<LogoutResult> {
    // Scoped by user id inside the session service, so one session cannot revoke
    // another account's session (no IDOR), and the token stops working at once.
    await this.sessions.revokeOwnedSession(user.id, user.sessionId, 'LOGOUT');
    await this.recordAudit('IDENTITY_LOGOUT', user.id, meta, { sessionId: user.sessionId }, user.roleCode);

    return { status: 'SIGNED_OUT' };
  }

  /**
   * Rotation: the presented refresh token becomes useless and a new pair is issued in
   * its place. Presenting an already-rotated token revokes the whole family and gets
   * exactly the answer an unknown token gets, so a thief learns nothing.
   */
  async refresh(body: unknown, meta: RequestMetadata = {}): Promise<RefreshResult> {
    const refreshToken = parseRefreshBody(body);

    await this.enforceRateLimit([
      { key: ipRateLimitKey('refresh', meta.ip ?? ''), ...RATE_LIMITS.refreshPerIp },
    ]);

    try {
      const issued = await this.sessions.rotate(refreshToken, { ip: meta.ip, userAgent: meta.userAgent });

      return {
        accessToken: issued.accessToken,
        accessExpiresAt: issued.accessExpiresAt.toISOString(),
        refreshToken: issued.refreshToken,
        refreshExpiresAt: issued.refreshExpiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof RefreshTokenReuseError) {
        // The family is already revoked; the only thing left is to record whose it was.
        await this.recordAudit('IDENTITY_REFRESH_REUSE_DETECTED', error.userId, meta, {
          familyId: error.familyId,
        });
      }

      throw error;
    }
  }

  /**
   * Always answers the same way. The address is rate limited before it is looked up,
   * so the limiter cannot be used to find out whether an account exists either.
   */
  async forgotPassword(body: unknown, meta: RequestMetadata = {}): Promise<ForgotPasswordResult> {
    const input = parseForgotPasswordBody(body);

    await this.enforceRateLimit([
      { key: ipRateLimitKey('password-reset', meta.ip ?? ''), ...RATE_LIMITS.passwordResetPerIp },
      {
        key: accountRateLimitKey('password-reset', input.email),
        ...RATE_LIMITS.passwordResetPerAccount,
      },
    ]);

    const human = await this.turnstile.verify(input.turnstileToken, meta.ip);
    if (!human) {
      throw new BadRequestException('Human verification failed. Please try again.');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, status: true },
    });

    // Only a live account gets a link, and only its owner could use one anyway.
    if (user && user.status === 'ACTIVE') {
      await this.issuePasswordResetToken(user.id, input.email, meta);
    }

    return RESET_REQUESTED;
  }

  /**
   * A single-use link that ends every session the account holds: a password reset is
   * the response to a suspected compromise, so nothing signed in before it survives.
   */
  async resetPassword(body: unknown, meta: RequestMetadata = {}): Promise<ResetPasswordResult> {
    const input = parseResetPasswordBody(body);

    await this.enforceRateLimit([
      { key: ipRateLimitKey('password-reset-submit', meta.ip ?? ''), ...RATE_LIMITS.passwordResetSubmitPerIp },
    ]);

    const row = await this.prisma.emailToken.findUnique({
      where: { tokenHash: hashToken(input.token) },
      select: { id: true, userId: true, purpose: true, expiresAt: true, usedAt: true },
    });

    if (!row || row.purpose !== 'RESET_PASSWORD' || row.usedAt !== null || isExpired(row.expiresAt)) {
      throw new BadRequestException('This reset link is invalid or has expired.');
    }

    // Hashing is deliberately slow, so it happens before the transaction opens.
    const passwordHash = await hashPassword(input.newPassword);

    await this.prisma.$transaction(async (tx) => {
      // Single use: the conditional update is what makes a replay impossible even
      // when two requests arrive together.
      const consumed = await tx.emailToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      if (consumed.count !== 1) {
        throw new BadRequestException('This reset link is invalid or has expired.');
      }

      await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });

      const now = new Date();
      const revoked = await tx.session.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'PASSWORD_RESET', accessExpiresAt: now },
      });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_PASSWORD_RESET',
        actorUserId: row.userId,
        entityId: row.userId,
        metadata: {},
        ip: meta.ip ?? null,
      });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_SESSIONS_REVOKED',
        actorUserId: row.userId,
        entityId: row.userId,
        metadata: { reason: 'PASSWORD_RESET', count: revoked.count },
        ip: meta.ip ?? null,
      });
    });

    return { status: 'PASSWORD_RESET' };
  }

  private async issuePasswordResetToken(userId: string, email: string, meta: RequestMetadata): Promise<void> {
    const token = generateToken();
    const tokenExpiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      // One live reset link per account: asking again kills the previous one.
      await tx.emailToken.updateMany({
        where: { userId, purpose: 'RESET_PASSWORD', usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.emailToken.create({
        data: {
          userId,
          purpose: 'RESET_PASSWORD',
          tokenHash: hashToken(token),
          expiresAt: tokenExpiresAt,
          requestIp: meta.ip ?? null,
        },
      });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_PASSWORD_RESET_REQUESTED',
        actorUserId: userId,
        entityId: userId,
        metadata: { email },
        ip: meta.ip ?? null,
      });
    });

    await this.sendPasswordResetEmail(email, token, tokenExpiresAt);
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
    actorRole = 'USER',
  ): Promise<void> {
    await writeIdentityAudit(this.prisma, {
      action,
      actorUserId: userId,
      actorRole,
      entityType: 'user',
      entityId: userId,
      metadata,
      ip: meta.ip ?? null,
    });
  }

  private async recordLoginFailure(
    userId: string | null,
    email: string,
    reason: string,
    meta: RequestMetadata,
    throttle?: { readonly pairKey: string; readonly accountKey: string },
  ): Promise<void> {
    await writeIdentityAudit(this.prisma, {
      action: 'IDENTITY_LOGIN_FAILED',
      actorUserId: userId,
      entityType: userId === null ? null : 'user',
      entityId: userId,
      metadata: { email, reason },
      ip: meta.ip ?? null,
    });

    if (throttle) {
      await this.recordThrottleHit(throttle.pairKey, throttle.accountKey);
    }
  }

  /**
   * Two counters for one failure: this address for this account (which has its own
   * ceiling) and the account as a whole (which asks for a human check at a much
   * higher one). Neither ever refuses the owner.
   */
  private async recordThrottleHit(pairKey: string, accountKey: string): Promise<void> {
    await this.rateLimiter.hit(pairKey, RATE_LIMITS.loginPair.windowSeconds);
    await this.rateLimiter.hit(accountKey, LOGIN_THROTTLE.accountWindowSeconds);
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

  private async sendPasswordResetEmail(email: string, token: string, expiresAt: Date): Promise<void> {
    const link = `${this.webUrl}/reset-password?token=${encodeURIComponent(token)}`;

    try {
      await this.email.send({
        to: email,
        subject: 'Reset your Abhyas password',
        text: [
          'Somebody asked to reset the password for this Abhyas account.',
          '',
          'Choose a new password here:',
          link,
          '',
          `The link is valid until ${expiresAt.toISOString()} and works once.`,
          'If this was not you, ignore this message: nothing has changed.',
        ].join('\n'),
      });
    } catch (error) {
      // Never let a mail outage turn a reset request into an error response: that
      // would tell the caller the address exists.
      this.logger.error(`Could not send the password reset email: ${error instanceof Error ? error.message : String(error)}`);
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

let dummyHashValue: Promise<string> | undefined;

/** One throwaway hash, so an unknown address costs what a wrong password costs. */
function dummyHash(): Promise<string> {
  dummyHashValue ??= hashPassword('abhyas-dummy-password-9x');
  return dummyHashValue;
}

/**
 * The progressive sign-in delay. Small on purpose: it is one of three throttles, and
 * the other two are the ones that actually stop a guesser.
 */
function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}
