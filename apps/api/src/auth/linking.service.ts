import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { loadConfig } from '../config/config';
import { webUrlFor } from '../config/links';
import { DatabaseService } from '../infra/database.service';
import { EMAIL_SENDER, type EmailSender } from '../infra/email-sender';
import { DATABASE_PROBE } from '../infra/tokens';
import { nationalDigits } from '../otp/otp-code';
import { OtpService } from '../otp/otp.service';
import type { AuthenticatedUser } from './access';
import { writeIdentityAudit } from './audit';
import { isDisposableEmail } from './disposable-email';
import { ReauthenticationService } from './reauthentication.service';
import type { RequestMetadata } from './request';
import { EMAIL_TOKEN_TTL_MS, generateToken, hashToken, isExpired } from './tokens';
import {
  parseEmailLinkBody,
  parseEmailToken,
  parseMobileLinkBody,
  parseUnlinkMobileBody,
} from './validation';

/**
 * Adding or removing a way to sign in, on an account that already exists.
 *
 * Three rules shape this module:
 *
 * 1. **A link never merges two accounts.** An identifier that already belongs to somebody
 *    else is refused, and when saying so would confirm that it exists elsewhere the answer
 *    is the generic one a successful request gets. Nothing is ever moved between accounts.
 * 2. **A link is not an identifier.** A pending link is a single-use, hashed token with a
 *    lifetime, exactly like a verification link; the account changes only when it is
 *    confirmed by the signed-in person.
 * 3. **The last identifier cannot be removed.** An account with neither an email nor a
 *    verified mobile could not be signed into or recovered, and the database refuses it too.
 *
 * Every request, link, unlink and refusal writes an audit row with the identifier in it —
 * that is the one place an address is allowed to appear, because it is what a support
 * ticket needs.
 */

export const LINK_ACCEPTED = { status: 'ACCEPTED' } as const;
export const EMAIL_LINKED = { status: 'EMAIL_LINKED' } as const;
export const MOBILE_LINKED = { status: 'MOBILE_LINKED' } as const;
export const MOBILE_UNLINKED = { status: 'MOBILE_UNLINKED' } as const;

/** The one answer a taken identifier gets, whatever kind it is. */
export const IDENTIFIER_TAKEN_MESSAGE = 'That address cannot be added to this account.';
export const LAST_IDENTIFIER_MESSAGE = 'Add an email address before removing your only way to sign in.';

export type LinkAccepted = typeof LINK_ACCEPTED;
export type EmailLinked = typeof EMAIL_LINKED;
export type MobileLinked = typeof MOBILE_LINKED;
export type MobileUnlinked = typeof MOBILE_UNLINKED;

@Injectable()
export class LinkingService {
  private readonly logger = new Logger(LinkingService.name);
  private readonly webUrl: string;

  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(ReauthenticationService) private readonly reauth: ReauthenticationService,
  ) {
    this.webUrl = webUrlFor(loadConfig(process.env).NODE_ENV, process.env.WEB_URL);
  }

  private get prisma() {
    return this.database.prisma;
  }

  /**
   * Asks for a link to confirm a new email address. The account must have no email yet:
   * replacing one is a different, unbuilt operation, and quietly doing it here would mean a
   * stolen session could point password resets at another inbox.
   */
  async requestEmailLink(
    user: AuthenticatedUser,
    body: unknown,
    meta: RequestMetadata = {},
  ): Promise<LinkAccepted> {
    const input = parseEmailLinkBody(body);
    const account = await this.load(user.id);

    if (account.email !== null) {
      throw new BadRequestException('This account already has an email address.');
    }

    await this.reauth.assert(user, { password: input.password, code: input.code });

    if (isDisposableEmail(input.email)) {
      throw new BadRequestException('Use a permanent email address: throwaway inboxes are not accepted.');
    }

    const owner = await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });

    if (owner !== null && owner.id !== user.id) {
      // Saying "that address is taken" here would turn this route into a membership oracle
      // for email addresses. The answer is the one a successful request gets; the trail
      // records what actually happened.
      await this.recordRefusal(user, meta, input.email, 'ADDRESS_TAKEN', 'IDENTITY_EMAIL_LINK_REFUSED');
      return LINK_ACCEPTED;
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      // One live link per account: asking again kills the previous one.
      await tx.emailToken.updateMany({
        where: { userId: user.id, purpose: 'LINK_EMAIL', usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.emailToken.create({
        data: {
          userId: user.id,
          purpose: 'LINK_EMAIL',
          destination: input.email,
          tokenHash: hashToken(token),
          expiresAt,
          requestIp: meta.ip ?? null,
        },
      });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_EMAIL_LINK_REQUESTED',
        actorUserId: user.id,
        actorRole: user.roleCode,
        entityId: user.id,
        metadata: { email: input.email },
        ip: meta.ip ?? null,
      });
    });

    await this.sendLinkEmail(input.email, token, expiresAt);

    return LINK_ACCEPTED;
  }

  /** Confirms a link token owned by this account, and only then writes the address. */
  async verifyEmailLink(user: AuthenticatedUser, body: unknown, meta: RequestMetadata = {}): Promise<EmailLinked> {
    const token = parseEmailToken(body);

    const row = await this.prisma.emailToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, userId: true, purpose: true, expiresAt: true, usedAt: true, destination: true },
    });

    if (
      row === null ||
      row.userId !== user.id ||
      row.purpose !== 'LINK_EMAIL' ||
      row.usedAt !== null ||
      isExpired(row.expiresAt) ||
      row.destination === null
    ) {
      throw new BadRequestException('This link is invalid or has expired.');
    }

    const destination = row.destination;

    try {
      await this.prisma.$transaction(async (tx) => {
        // Single use: the conditional update is what makes a replay impossible even when
        // two requests arrive together.
        const consumed = await tx.emailToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
        if (consumed.count !== 1) {
          throw new BadRequestException('This link is invalid or has expired.');
        }

        await tx.user.update({
          where: { id: user.id },
          data: { email: destination, emailVerifiedAt: new Date() },
        });

        await writeIdentityAudit(tx, {
          action: 'IDENTITY_EMAIL_LINKED',
          actorUserId: user.id,
          actorRole: user.roleCode,
          entityId: user.id,
          metadata: { email: destination },
          ip: meta.ip ?? null,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.recordRefusal(user, meta, destination, 'ADDRESS_TAKEN', 'IDENTITY_EMAIL_LINK_REFUSED');
        throw new ConflictException(IDENTIFIER_TAKEN_MESSAGE);
      }
      throw error;
    }

    return EMAIL_LINKED;
  }

  /**
   * Adds a verified mobile number. The code proves the number; the re-authentication proves
   * the account, so a stolen session cannot attach the attacker's own phone to somebody.
   */
  async linkMobile(user: AuthenticatedUser, body: unknown, meta: RequestMetadata = {}): Promise<MobileLinked> {
    this.otp.assertEnabled();

    const input = parseMobileLinkBody(body);
    await this.reauth.assert(user, { password: input.password });

    const { destination } = await this.otp.verifyCode({
      destination: input.destination,
      purpose: 'LINK',
      code: input.code,
    });

    const owner = await this.prisma.user.findFirst({
      where: { firstVerifiedMobile: destination },
      select: { id: true },
    });

    if (owner !== null && owner.id !== user.id) {
      await this.recordRefusal(user, meta, destination, 'NUMBER_TAKEN', 'IDENTITY_MOBILE_LINK_REFUSED');
      throw new ConflictException(IDENTIFIER_TAKEN_MESSAGE);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            mobile: nationalDigits(destination),
            firstVerifiedMobile: destination,
            mobileVerifiedAt: new Date(),
          },
        });

        await writeIdentityAudit(tx, {
          action: 'IDENTITY_MOBILE_LINKED',
          actorUserId: user.id,
          actorRole: user.roleCode,
          entityId: user.id,
          metadata: { mobile: destination },
          ip: meta.ip ?? null,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.recordRefusal(user, meta, destination, 'NUMBER_TAKEN', 'IDENTITY_MOBILE_LINK_REFUSED');
        throw new ConflictException(IDENTIFIER_TAKEN_MESSAGE);
      }
      throw error;
    }

    return MOBILE_LINKED;
  }

  /** Removes the mobile number, refusing when it is the only identifier the account has. */
  async unlinkMobile(user: AuthenticatedUser, body: unknown, meta: RequestMetadata = {}): Promise<MobileUnlinked> {
    this.otp.assertEnabled();

    const input = parseUnlinkMobileBody(body);
    const account = await this.load(user.id);

    await this.reauth.assert(user, { password: input.password, code: input.code });

    if (account.firstVerifiedMobile === null) {
      throw new BadRequestException('This account has no mobile number to remove.');
    }

    if (account.email === null) {
      throw new BadRequestException(LAST_IDENTIFIER_MESSAGE);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { mobile: null, firstVerifiedMobile: null, mobileVerifiedAt: null },
      });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_MOBILE_UNLINKED',
        actorUserId: user.id,
        actorRole: user.roleCode,
        entityId: user.id,
        metadata: { mobile: account.firstVerifiedMobile },
        ip: meta.ip ?? null,
      });
    });

    return MOBILE_UNLINKED;
  }

  private async load(userId: string): Promise<{
    readonly email: string | null;
    readonly firstVerifiedMobile: string | null;
  }> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstVerifiedMobile: true },
    });

    if (row === null) {
      throw new NotFoundException('Account not found');
    }

    return row;
  }

  private async recordRefusal(
    user: AuthenticatedUser,
    meta: RequestMetadata,
    identifier: string,
    reason: string,
    action: string,
  ): Promise<void> {
    await writeIdentityAudit(this.prisma, {
      action,
      actorUserId: user.id,
      actorRole: user.roleCode,
      entityId: user.id,
      metadata: { identifier, reason } as Prisma.InputJsonObject,
      ip: meta.ip ?? null,
    });
  }

  private async sendLinkEmail(email: string, token: string, expiresAt: Date): Promise<void> {
    const link = `${this.webUrl}/link-email?token=${encodeURIComponent(token)}`;

    try {
      await this.email.send({
        to: email,
        subject: 'Confirm this email address for your Abhyas account',
        text: [
          'Somebody asked to add this address to an Abhyas account.',
          '',
          'Confirm it here, signed in to that account:',
          link,
          '',
          `The link is valid until ${expiresAt.toISOString()} and works once.`,
          'If this was not you, ignore this message: nothing has changed.',
        ].join('\n'),
      });
    } catch (error) {
      // The link exists whether or not the mail left; a mail outage must not leak that.
      this.logger.error(`Could not send the address link email: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}
