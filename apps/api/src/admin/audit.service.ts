import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/access';
import { writeIdentityAudit } from '../auth/audit';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { AUDIT_MAX_EXPORT_ROWS, type AuditQueryInput } from './operations.validation';

export interface AuditRow {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly actorRole: string | null;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly ip: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface AuditPage {
  readonly items: readonly AuditRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

/**
 * The audit viewer. Read-only by construction: the table rejects UPDATE and DELETE by
 * trigger, the application role has those privileges revoked, and this service exposes
 * no write path at all. Exporting is itself recorded, because taking a copy of the trail
 * is a thing an administrator did.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  private get prisma() {
    return this.database.prisma;
  }

  private whereFor(query: AuditQueryInput): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {};

    if (query.actorId !== undefined) {
      where.actorUserId = query.actorId;
    }
    if (query.action !== undefined) {
      where.action = { contains: query.action, mode: 'insensitive' };
    }
    if (query.from !== undefined || query.to !== undefined) {
      where.occurredAt = {
        ...(query.from === undefined ? {} : { gte: query.from }),
        ...(query.to === undefined ? {} : { lt: new Date(query.to.getTime() + 24 * 60 * 60 * 1000) }),
      };
    }

    return where;
  }

  async search(query: AuditQueryInput): Promise<AuditPage> {
    const where = this.whereFor(query);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { actor: { select: { email: true } } },
      }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        actorUserId: row.actorUserId,
        actorEmail: row.actor?.email ?? null,
        actorRole: row.actorRole,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        ip: row.ip,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      pages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /** A CSV of what the same filters would show, capped so one export cannot be a dump. */
  async exportCsv(
    actor: AuthenticatedUser,
    query: AuditQueryInput,
    meta: { readonly ip?: string | undefined } = {},
  ): Promise<{ csv: string; rows: number }> {
    const rows = await this.prisma.auditLog.findMany({
      where: this.whereFor(query),
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: AUDIT_MAX_EXPORT_ROWS,
      include: { actor: { select: { email: true } } },
    });

    const lines = [
      'occurred_at,actor_email,actor_role,action,entity_type,entity_id,ip,metadata',
      ...rows.map((row) =>
        [
          row.occurredAt.toISOString(),
          row.actor?.email ?? '',
          row.actorRole ?? '',
          row.action,
          row.entityType ?? '',
          row.entityId ?? '',
          row.ip ?? '',
          JSON.stringify(row.metadata ?? {}),
        ]
          .map(csvCell)
          .join(','),
      ),
    ];

    await writeIdentityAudit(this.prisma, {
      action: 'AUDIT_EXPORTED',
      actorUserId: actor.id,
      actorRole: actor.roleCode,
      entityType: 'audit_log',
      metadata: { rows: rows.length, action: query.action ?? null, actorId: query.actorId ?? null },
      ip: meta.ip ?? null,
    });

    return { csv: `${lines.join('\n')}\n`, rows: rows.length };
  }
}

/** RFC 4180 quoting: a value with a comma, a quote or a newline is quoted and doubled. */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
