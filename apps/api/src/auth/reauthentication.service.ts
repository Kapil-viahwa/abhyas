import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { DatabaseService } from '../infra/database.service';
import { RateLimiter } from '../infra/rate-limiter';
import { DATABASE_PROBE } from '../infra/tokens';
import { OtpService, type OtpRequestResult } from '../otp/otp.service';
import type { AuthenticatedUser } from './access';
import { writeIdentityAudit } from './audit';
import { verifyPassword } from './password';
import type { RequestMetadata } from './request';
import { parseReauthenticationBody } from './validation';

/**
 * Re-authentication: proving it is still the account holder before a change that could
 * change how somebody signs in, or take the account away from them.
 *
 * Three proofs are accepted, in this order, and the reason for the order matters:
 *
 * 1. The current password, whenever one is offered. It is checked for every account that
 *    has one — including an account that was created with a mobile number and later chose
 *    a password.
 * 2. A one-time code sent to the account's own verified number. This is the path for an
 *    account created by mobile, whose stored password hash is of a random value the
 *    platform generated and nobody knows.
 * 3. A sign-in in the last fifteen minutes, and only for an account with no email
 *    address. That account has no password it could offer, and sending an SMS is not
 *    always possible; a session that was created minutes ago is the same evidence as a
 *    password typed a minute ago.
 *
 * Recent-ness is never accepted for an account with an email address: there, the password
 * is available, and asking for it is what stops a stolen session from changing it.
 */

export const REAUTH_WINDOW_MS = 15 * 60 * 1000;

/** Five wrong proofs in fifteen minutes: a stolen session does not get unlimited guesses. */
export const REAUTH_FAILURE_LIMIT = 5;
export const REAUTH_FAILURE_WINDOW_SECONDS = 900;

export const REAUTH_LOCKED_MESSAGE = 'Too many confirmation attempts. Try again in fifteen minutes.';

export const REAUTH_CODE_REQUIRED_MESSAGE =
  'Enter the code sent to your mobile number to confirm this change.';

/** One key per account: every route that asks for a proof shares the counter. */
export function reauthFailureKey(userId: string): string {
  return `ratelimit:reauth:failures:user:${userId}`;
}

/** What a sensitive route accepts alongside the change itself. */
export interface ReauthenticationProof {
  readonly password?: string | undefined;
  readonly code?: string | undefined;
}

export interface ReauthenticationMessages {
  readonly missingPasswordMessage: string;
  readonly wrongPasswordMessage: string;
}

export const DEFAULT_REAUTH_MESSAGES: ReauthenticationMessages = {
  missingPasswordMessage: 'Enter your current password',
  wrongPasswordMessage: 'Your current password is incorrect.',
};

/** Raised with the reason a fresh session is not enough, so the screen can say what to do. */
export const REAUTH_REFUSED_MESSAGE =
  'Confirm it is you before this change: enter your password, or ask for a code sent to your mobile number.';

@Injectable()
export class ReauthenticationService {
  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  private get prisma() {
    return this.database.prisma;
  }

  /**
   * Sends a code to the account's own verified number. The destination is read here and
   * never taken from the request, so this route cannot be used to send a code anywhere.
   */
  async sendCode(
    user: AuthenticatedUser,
    body: unknown,
    meta: RequestMetadata = {},
  ): Promise<OtpRequestResult> {
    this.otp.assertEnabled();

    const input = parseReauthenticationBody(body);
    const account = await this.load(user.id);

    if (account.firstVerifiedMobile === null) {
      throw new BadRequestException('This account has no verified mobile number to send a code to.');
    }

    return this.otp.requestCode(
      {
        destination: account.firstVerifiedMobile,
        purpose: 'REAUTH',
        turnstileToken: input.turnstileToken,
      },
      meta,
    );
  }

  /** Throws unless one of the three proofs holds for this account. */
  async assert(
    user: AuthenticatedUser,
    proof: ReauthenticationProof,
    meta: RequestMetadata = {},
    messages: ReauthenticationMessages = DEFAULT_REAUTH_MESSAGES,
  ): Promise<void> {
    // A stolen session gets five guesses at a proof and no more. The counter is shared by
    // every sensitive route, because the proofs are interchangeable between them.
    if ((await this.limiter.count(reauthFailureKey(user.id))) >= REAUTH_FAILURE_LIMIT) {
      throw new HttpException(REAUTH_LOCKED_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }

    const account = await this.load(user.id);

    if (typeof proof.password === 'string' && proof.password !== '') {
      if (!(await verifyPassword(account.passwordHash, proof.password))) {
        await this.recordFailure(user, 'WRONG_PASSWORD', meta);
        throw new BadRequestException(messages.wrongPasswordMessage);
      }
      await this.limiter.reset(reauthFailureKey(user.id));
      return;
    }

    if (typeof proof.code === 'string' && proof.code !== '') {
      if (account.firstVerifiedMobile === null) {
        throw new BadRequestException('This account has no verified mobile number to confirm with.');
      }
      try {
        await this.otp.verifyCode(
          {
            destination: account.firstVerifiedMobile,
            purpose: 'REAUTH',
            code: proof.code,
          },
          meta,
        );
      } catch (error) {
        await this.recordFailure(user, 'WRONG_CODE', meta);
        throw error;
      }
      await this.limiter.reset(reauthFailureKey(user.id));
      return;
    }

    // No proof offered. Only an account with no email address may rely on anything else,
    // because it has no password anybody could type.
    if (account.email !== null) {
      throw new BadRequestException(messages.missingPasswordMessage);
    }

    // With the switch on and a verified number, the code is required even here: a session
    // minutes old is a weaker proof than a code only the holder's own phone receives.
    if (this.otp.isEnabled() && account.firstVerifiedMobile !== null) {
      throw new BadRequestException(REAUTH_CODE_REQUIRED_MESSAGE);
    }

    const session = await this.prisma.session.findFirst({
      where: { id: user.sessionId, userId: user.id },
      select: { issuedAt: true },
    });

    if (session === null || Date.now() - session.issuedAt.getTime() > REAUTH_WINDOW_MS) {
      throw new ForbiddenException(REAUTH_REFUSED_MESSAGE);
    }
  }

  /** A wrong proof is counted and audited: the refusal is evidence, not just an answer. */
  private async recordFailure(
    user: AuthenticatedUser,
    reason: 'WRONG_PASSWORD' | 'WRONG_CODE',
    meta: RequestMetadata,
  ): Promise<void> {
    await this.limiter.hit(reauthFailureKey(user.id), REAUTH_FAILURE_WINDOW_SECONDS);
    await writeIdentityAudit(this.prisma, {
      action: 'IDENTITY_REAUTH_FAILED',
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      metadata: { reason },
      ip: meta.ip ?? null,
    });
  }

  private async load(userId: string): Promise<{
    readonly email: string | null;
    readonly passwordHash: string;
    readonly firstVerifiedMobile: string | null;
  }> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, passwordHash: true, firstVerifiedMobile: true },
    });

    if (row === null) {
      throw new NotFoundException('Account not found');
    }

    return row;
  }
}
