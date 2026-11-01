import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/access';
import { writeIdentityAudit } from '../auth/audit';
import { hashPassword } from '../auth/password';
import {
  parseCreateEditorBody,
  parseEditorFlagsBody,
  parseRoleChangeBody,
  parseUserListQuery,
  parseUserStatusBody,
  parseUuid,
  type UserListQueryInput,
} from '../auth/validation';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { EDITOR_FLAG_CODES, codesForFlags, flagsFromCodes, type EditorFlags } from './editor-flags';

export interface RoleChangeResult {
  readonly userId: string;
  readonly roleCode: string;
  readonly sessionsRevoked: number;
}

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleCode: string;
  readonly status: string;
  readonly emailVerifiedAt: string | null;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  /** Which editor capabilities this account actually holds, read from its grants. */
  readonly editorFlags: EditorFlags;
}

export interface UserDetail extends UserSummary {
  readonly activeSessions: number;
}

export interface UserListResult {
  readonly items: readonly UserSummary[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

interface AuditMeta {
  readonly ip?: string | undefined;
}

const USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  status: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  role: { select: { code: true } },
  permissions: { select: { permission: { select: { code: true } } } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

function toSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    roleCode: row.role.code,
    status: row.status,
    emailVerifiedAt: row.emailVerifiedAt?.toISOString() ?? null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    editorFlags: flagsFromCodes(row.permissions.map((grant) => grant.permission.code)),
  };
}

/**
 * User administration.
 *
 * Everything here is Admin work: the permission that gates each route lives on
 * `AdminController`, so an editor cannot reach any of it. Every write ends the
 * sessions it invalidates in the same transaction and leaves an audit row, so the
 * trail shows the attempt as well as its effect.
 */
@Injectable()
export class AdminUsersService {
  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  private get prisma() {
    return this.database.prisma;
  }

  async list(query: UserListQueryInput): Promise<UserListResult> {
    const where: Prisma.UserWhereInput = {};

    if (query.search !== undefined) {
      where.OR = [
        { email: { contains: query.search, mode: 'insensitive' } },
        { fullName: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.roleCode !== undefined) {
      where.role = { code: query.roleCode };
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { email: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: USER_SELECT,
      }),
    ]);

    return {
      items: rows.map(toSummary),
      total,
      page: query.page,
      pageSize: query.pageSize,
      pages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async detail(userId: string): Promise<UserDetail> {
    const targetId = parseUuid(userId, 'user id');

    const row = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: {
        ...USER_SELECT,
        _count: {
          select: {
            sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } },
          },
        },
      },
    });

    if (!row) {
      throw new NotFoundException('Unknown user');
    }

    return { ...toSummary(row), activeSessions: row._count.sessions };
  }

  /**
   * Creates an editor. The account and its capability grants are one transaction, so
   * no editor can exist without the flags the Administrator ticked.
   */
  async createEditor(actor: AuthenticatedUser, body: unknown, meta: AuditMeta = {}): Promise<UserDetail> {
    const input = parseCreateEditorBody(body);

    const role = await this.prisma.role.findUnique({ where: { code: 'EDITOR' }, select: { id: true } });
    if (!role) {
      throw new NotFoundException('Unknown role');
    }

    const existing = await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (existing) {
      throw new ConflictException('An account with that email address already exists');
    }

    const passwordHash = await hashPassword(input.password);
    const permissionIds = await this.permissionIdsFor(input.flags);

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          fullName: input.fullName,
          passwordHash,
          roleId: role.id,
          // An Administrator vouched for the address by creating the account.
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      });

      if (permissionIds.length > 0) {
        await tx.userPermission.createMany({
          data: permissionIds.map((permissionId) => ({
            userId: user.id,
            permissionId,
            grantedBy: actor.id,
          })),
        });
      }

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_EDITOR_CREATED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityId: user.id,
        metadata: { email: input.email, flags: codesForFlags(input.flags) },
        ip: meta.ip ?? null,
      });

      return user.id;
    });

    return this.detail(created);
  }

  /**
   * Replaces an editor's capability set and ends that editor's sessions, because a
   * token issued under the old set must not outlive it. A missing flag grants nothing.
   */
  async updateEditorFlags(
    actor: AuthenticatedUser,
    userId: string,
    body: unknown,
    meta: AuditMeta = {},
  ): Promise<UserDetail> {
    const targetId = parseUuid(userId, 'user id');
    const flags = parseEditorFlagsBody(body);

    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: { select: { code: true } } },
    });
    if (!target) {
      throw new NotFoundException('Unknown user');
    }
    if (target.role.code !== 'EDITOR') {
      throw new BadRequestException('Only an editor account holds editor capability');
    }

    const previous = await this.prisma.userPermission.findMany({
      where: { userId: target.id, permission: { code: { in: [...EDITOR_FLAG_CODES] } } },
      select: { permission: { select: { code: true } } },
    });
    const wanted = await this.permissionIdsFor(flags);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.userPermission.deleteMany({
        where: { userId: target.id, permission: { code: { in: [...EDITOR_FLAG_CODES] } } },
      });

      if (wanted.length > 0) {
        await tx.userPermission.createMany({
          data: wanted.map((permissionId) => ({ userId: target.id, permissionId, grantedBy: actor.id })),
        });
      }

      const revoked = await tx.session.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'ADMIN_REVOKED', accessExpiresAt: now },
      });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_EDITOR_FLAGS_CHANGED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityId: target.id,
        metadata: {
          before: previous.map((row) => row.permission.code),
          after: codesForFlags(flags),
        },
        ip: meta.ip ?? null,
      });

      if (revoked.count > 0) {
        await writeIdentityAudit(tx, {
          action: 'IDENTITY_SESSIONS_REVOKED',
          actorUserId: actor.id,
          actorRole: actor.roleCode,
          entityId: target.id,
          metadata: { reason: 'ADMIN_REVOKED', count: revoked.count },
          ip: meta.ip ?? null,
        });
      }
    });

    return this.detail(target.id);
  }

  /** Activates, suspends or deactivates an account; leaving ACTIVE ends its sessions. */
  async changeStatus(
    actor: AuthenticatedUser,
    userId: string,
    body: unknown,
    meta: AuditMeta = {},
  ): Promise<UserDetail> {
    const targetId = parseUuid(userId, 'user id');
    const status = parseUserStatusBody(body);

    if (targetId === actor.id && status !== 'ACTIVE') {
      throw new BadRequestException('You cannot suspend or deactivate your own account');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, status: true },
    });
    if (!target) {
      throw new NotFoundException('Unknown user');
    }

    const now = new Date();
    const reason = status === 'DISABLED' ? 'ACCOUNT_DEACTIVATED' : 'ADMIN_REVOKED';

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: target.id }, data: { status } });

      const revoked =
        status === 'ACTIVE'
          ? { count: 0 }
          : await tx.session.updateMany({
              where: { userId: target.id, revokedAt: null },
              data: { revokedAt: now, revokeReason: reason, accessExpiresAt: now },
            });

      await writeIdentityAudit(tx, {
        action: 'IDENTITY_USER_STATUS_CHANGED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityId: target.id,
        metadata: { from: target.status, to: status },
        ip: meta.ip ?? null,
      });

      if (revoked.count > 0) {
        await writeIdentityAudit(tx, {
          action: 'IDENTITY_SESSIONS_REVOKED',
          actorUserId: actor.id,
          actorRole: actor.roleCode,
          entityId: target.id,
          metadata: { reason, count: revoked.count },
          ip: meta.ip ?? null,
        });
      }
    });

    return this.detail(target.id);
  }

  /**
   * Changes a role. Sessions end in the same transaction, so nobody keeps a token
   * that predates their old role; the database also clears editor capability the new
   * role no longer justifies.
   */
  async changeRole(
    actor: AuthenticatedUser,
    userId: string,
    body: unknown,
    meta: AuditMeta = {},
  ): Promise<RoleChangeResult> {
    const targetId = parseUuid(userId, 'user id');
    const roleCode = parseRoleChangeBody(body);

    const role = await this.prisma.role.findUnique({ where: { code: roleCode }, select: { id: true } });
    if (!role) {
      throw new NotFoundException('Unknown role');
    }

    if (targetId === actor.id && roleCode !== actor.roleCode) {
      throw new BadRequestException('You cannot change your own role');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: { select: { code: true } } },
    });
    if (!target) {
      throw new NotFoundException('Unknown user');
    }

    let sessionsRevoked = 0;
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
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

  private async permissionIdsFor(flags: Partial<EditorFlags>): Promise<string[]> {
    const codes = codesForFlags(flags);
    if (codes.length === 0) {
      return [];
    }

    const rows = await this.prisma.permission.findMany({
      where: { code: { in: codes } },
      select: { id: true },
    });

    if (rows.length !== codes.length) {
      throw new NotFoundException('The editor permission catalog is incomplete');
    }

    return rows.map((row) => row.id);
  }
}
