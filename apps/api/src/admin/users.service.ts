import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/access';
import { writeIdentityAudit } from '../auth/audit';
import type { RequestMetadata } from '../auth/request';
import { parseRoleChangeBody, parseUuid } from '../auth/validation';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';

export interface RoleChangeResult {
  readonly userId: string;
  readonly roleCode: string;
  readonly sessionsRevoked: number;
}

/**
 * User administration. One endpoint so far: changing a role. The permission that
 * gates it lives on the controller, and the sessions it ends are part of the same
 * transaction, so nobody keeps a token that predates their old role.
 */
@Injectable()
export class AdminUsersService {
  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  private get prisma() {
    return this.database.prisma;
  }

  async changeRole(
    actor: AuthenticatedUser,
    userId: string,
    body: unknown,
    meta: RequestMetadata = {},
  ): Promise<RoleChangeResult> {
    const targetId = parseUuid(userId, 'user id');
    const roleCode = parseRoleChangeBody(body);

    const role = await this.prisma.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) {
      throw new NotFoundException('Unknown role');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: { select: { code: true } } },
    });
    if (!target) {
      throw new NotFoundException('Unknown user');
    }

    let sessionsRevoked = 0;

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const revoked = await tx.session.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'ROLE_CHANGED', accessExpiresAt: now },
      });
      sessionsRevoked = revoked.count;

      await tx.user.update({ where: { id: target.id }, data: { roleId: role.id } });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_ROLE_CHANGED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityId: target.id,
        metadata: { fromRole: target.role.code, toRole: roleCode },
        ip: meta.ip ?? null,
      });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_SESSIONS_REVOKED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityId: target.id,
        metadata: { reason: 'ROLE_CHANGED', count: revoked.count },
        ip: meta.ip ?? null,
      });
    });

    return { userId: target.id, roleCode, sessionsRevoked };
  }
}
