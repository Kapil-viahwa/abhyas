import type { Prisma } from '@prisma/client';

/**
 * Identity events all have the same shape: an action code, the person it concerns,
 * who caused it, and the request that carried it. One writer keeps the audit trail
 * consistent, and it works inside a transaction so an event is never recorded for a
 * write that then rolls back.
 */
export type AuditClient = Pick<Prisma.TransactionClient, 'auditLog'>;

export interface IdentityAuditEntry {
  readonly action: string;
  readonly actorUserId?: string | null;
  readonly actorRole?: string | null;
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly metadata?: Prisma.InputJsonObject;
  readonly ip?: string | null;
}

export async function writeIdentityAudit(client: AuditClient, entry: IdentityAuditEntry): Promise<void> {
  await client.auditLog.create({
    data: {
      action: entry.action,
      actorUserId: entry.actorUserId ?? null,
      actorRole: entry.actorRole ?? 'USER',
      entityType: entry.entityType ?? 'user',
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? {},
      ip: entry.ip ?? null,
    },
  });
}
