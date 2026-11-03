import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import type { AuthenticatedUser } from './access';
import { writeIdentityAudit } from './audit';
import { hashPassword, verifyPassword } from './password';
import type { RequestMetadata } from './request';
import { SESSIONS_SERVICE, type SessionSummary, type SessionsService } from './sessions.service';
import { parseChangePasswordBody, parseDeactivateBody, parseUuid } from './validation';

/**
 * Everything a signed-in person does to their own account. Each write that changes a
 * credential ends the sessions it must in the same transaction as the change, and
 * writes the audit rows that go with it.
 */

export interface SessionListResult {
  readonly sessions: readonly SessionSummary[];
}

export interface ProfileResult {
  readonly id: string;
  /** Null for an account that signed up with a mobile number and has not linked an email. */
  readonly email: string | null;
  readonly fullName: string;
  readonly roleCode: string;
  readonly permissions: readonly string[];
}

export interface SessionRevokedResult {
  readonly status: 'REVOKED';
}

export interface OtherSessionsRevokedResult {
  readonly status: 'REVOKED';
  readonly revoked: number;
}

export interface PasswordChangedResult {
  readonly status: 'PASSWORD_CHANGED';
}

export interface DeactivatedResult {
  readonly status: 'DEACTIVATED';
}

@Injectable()
export class AccountService {
  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(SESSIONS_SERVICE) private readonly sessions: SessionsService,
  ) {}

  private get prisma() {
    return this.database.prisma;
  }

  async listSessions(user: AuthenticatedUser): Promise<SessionListResult> {
    const sessions = await this.sessions.listForUser(user.id, user.sessionId);
    return { sessions };
  }

  /** Who the caller is. The one endpoint a server-rendered page needs before it can render. */
  async profile(user: AuthenticatedUser): Promise<ProfileResult> {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true, fullName: true, role: { select: { code: true } } },
    });

    if (!row) {
      throw new NotFoundException('Account not found');
    }

    return {
      id: row.id,
      email: row.email,
      fullName: row.fullName,
      roleCode: row.role.code,
      permissions: [...user.permissions].sort(),
    };
  }

  async revokeSession(
    user: AuthenticatedUser,
    sessionId: string,
    meta: RequestMetadata = {},
  ): Promise<SessionRevokedResult> {
    const id = parseUuid(sessionId, 'session id');

    // Ownership is part of the query, so somebody else's session id and an id that
    // never existed look identical from here.
    const revoked = await this.sessions.revokeOwnedSession(user.id, id, 'USER_REVOKED');
    if (!revoked) {
      throw new NotFoundException('Session not found');
    }

    await writeIdentityAudit(this.prisma, {
      action: 'IDENTITY_SESSION_REVOKED',
      actorUserId: user.id,
      actorRole: user.roleCode,
      entityId: user.id,
      metadata: { sessionId: id, reason: 'USER_REVOKED' },
      ip: meta.ip ?? null,
    });

    return { status: 'REVOKED' };
  }

  async revokeOtherSessions(
    user: AuthenticatedUser,
    meta: RequestMetadata = {},
  ): Promise<OtherSessionsRevokedResult> {
    const revoked = await this.sessions.revokeAllExcept(user.id, user.sessionId, 'USER_REVOKED');

    await writeIdentityAudit(this.prisma, {
      action: 'IDENTITY_SESSIONS_REVOKED',
      actorUserId: user.id,
      actorRole: user.roleCode,
      entityId: user.id,
      metadata: { reason: 'USER_REVOKED', count: revoked, keptSessionId: user.sessionId },
      ip: meta.ip ?? null,
    });

    return { status: 'REVOKED', revoked };
  }

  /** Keeps the session that asked, and ends every other one. */
  async changePassword(
    user: AuthenticatedUser,
    body: unknown,
    meta: RequestMetadata = {},
  ): Promise<PasswordChangedResult> {
    const input = parseChangePasswordBody(body);

    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!row) {
      throw new NotFoundException('Account not found');
    }

    const matches = await verifyPassword(row.passwordHash, input.currentPassword);
    if (!matches) {
      throw new BadRequestException('Your current password is incorrect.');
    }

    if (input.currentPassword === input.newPassword) {
      throw new BadRequestException('Choose a password different from your current one.');
    }

    // Hashing is deliberately slow, so it happens before the transaction opens.
    const passwordHash = await hashPassword(input.newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });

      const now = new Date();
      const revoked = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, id: { not: user.sessionId } },
        data: { revokedAt: now, revokeReason: 'PASSWORD_CHANGED', accessExpiresAt: now },
      });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_PASSWORD_CHANGED',
        actorUserId: user.id,
        actorRole: user.roleCode,
        entityId: user.id,
        metadata: {},
        ip: meta.ip ?? null,
      });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_SESSIONS_REVOKED',
        actorUserId: user.id,
        actorRole: user.roleCode,
        entityId: user.id,
        metadata: { reason: 'PASSWORD_CHANGED', count: revoked.count, keptSessionId: user.sessionId },
        ip: meta.ip ?? null,
      });
    });

    return { status: 'PASSWORD_CHANGED' };
  }

  /** Deactivation is a password-guarded, irreversible-from-here action: every session ends. */
  async deactivate(
    user: AuthenticatedUser,
    body: unknown,
    meta: RequestMetadata = {},
  ): Promise<DeactivatedResult> {
    const input = parseDeactivateBody(body);

    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!row) {
      throw new NotFoundException('Account not found');
    }

    const matches = await verifyPassword(row.passwordHash, input.password);
    if (!matches) {
      throw new BadRequestException('Your password is incorrect.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });

      const now = new Date();
      const revoked = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'ACCOUNT_DEACTIVATED', accessExpiresAt: now },
      });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_ACCOUNT_DEACTIVATED',
        actorUserId: user.id,
        actorRole: user.roleCode,
        entityId: user.id,
        metadata: {},
        ip: meta.ip ?? null,
      });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_SESSIONS_REVOKED',
        actorUserId: user.id,
        actorRole: user.roleCode,
        entityId: user.id,
        metadata: { reason: 'ACCOUNT_DEACTIVATED', count: revoked.count },
        ip: meta.ip ?? null,
      });
    });

    return { status: 'DEACTIVATED' };
  }
}
