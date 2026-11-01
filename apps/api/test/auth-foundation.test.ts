import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Phase 2a database rules: the role x permission matrix, the session and email-token
 * constraints, the outbox, and — most importantly — the privileges of the database
 * user the API connects as.
 */

describe('auth foundation', () => {
  let db!: TestDatabase;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('auth');
  }, 120_000);

  afterAll(async () => {
    await db?.dispose();
  }, 60_000);

  describe('role_permissions', () => {
    it('seeds the matrix: ADMIN everything, EDITOR content only, USER attempts only', async () => {
      const rows = await db.client.$queryRawUnsafe<Array<{ role_code: string; permission_code: string }>>(
        `SELECT r."code" AS role_code, p."code" AS permission_code
         FROM "role_permissions" rp
         JOIN "roles" r ON r."id" = rp."role_id"
         JOIN "permissions" p ON p."id" = rp."permission_id"`,
      );

      const byRole = new Map<string, string[]>();
      for (const row of rows) {
        byRole.set(row.role_code, [...(byRole.get(row.role_code) ?? []), row.permission_code]);
      }

      const totalPermissions = await db.client.permission.count();
      expect(byRole.get('ADMIN')).toHaveLength(totalPermissions);

      expect(new Set(byRole.get('EDITOR'))).toEqual(
        new Set(['content.read', 'content.write', 'tests.read', 'tests.write']),
      );
      expect(new Set(byRole.get('USER'))).toEqual(new Set(['attempts.take']));
    });

    it('cannot grant a role the same permission twice', async () => {
      const role = await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
      const permission = await db.client.permission.findUniqueOrThrow({
        where: { code: 'attempts.take' },
        select: { id: true },
      });

      await expect(
        db.client.$executeRawUnsafe(
          'INSERT INTO "role_permissions" ("role_id", "permission_id") VALUES ($1::uuid, $2::uuid)',
          role.id,
          permission.id,
        ),
      ).rejects.toThrow();
    });
  });

  describe('sessions', () => {
    async function createUser(): Promise<string> {
      const role = await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
      const user = await db.client.user.create({
        data: {
          email: `session-${randomUUID().slice(0, 8)}@example.com`,
          fullName: 'Session Owner',
          passwordHash: 'placeholder-hash',
          roleId: role.id,
        },
        select: { id: true },
      });
      return user.id;
    }

    function sessionValues(userId: string) {
      return {
        userId,
        familyId: randomUUID(),
        refreshTokenHash: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      };
    }

    it('stores a session and rejects a revoked session without a reason', async () => {
      const userId = await createUser();
      const values = sessionValues(userId);

      await expect(db.client.session.create({ data: values })).resolves.toBeTruthy();

      await expect(
        db.client.$executeRawUnsafe(
          `INSERT INTO "sessions" ("user_id", "family_id", "refresh_token_hash", "expires_at", "revoked_at")
           VALUES ($1::uuid, $2::uuid, $3, now() + interval '30 days', now())`,
          userId,
          randomUUID(),
          `hash-${randomUUID()}`,
        ),
      ).rejects.toThrow();
    });

    it('rejects an expiry that is not after the issue time', async () => {
      const userId = await createUser();

      await expect(
        db.client.$executeRawUnsafe(
          `INSERT INTO "sessions" ("user_id", "family_id", "refresh_token_hash", "expires_at")
           VALUES ($1::uuid, $2::uuid, $3, now() - interval '1 day')`,
          userId,
          randomUUID(),
          `hash-${randomUUID()}`,
        ),
      ).rejects.toThrow();
    });

    it('rejects an unknown revoke reason and a duplicate refresh hash', async () => {
      const userId = await createUser();
      const values = sessionValues(userId);

      await expect(
        db.client.$executeRawUnsafe(
          `INSERT INTO "sessions" ("user_id", "family_id", "refresh_token_hash", "expires_at", "revoked_at", "revoke_reason")
           VALUES ($1::uuid, $2::uuid, $3, now() + interval '30 days', now(), 'BECAUSE_I_SAID_SO')`,
          userId,
          randomUUID(),
          `hash-${randomUUID()}`,
        ),
      ).rejects.toThrow();

      await db.client.session.create({ data: values });

      await expect(db.client.session.create({ data: { ...values, familyId: randomUUID() } })).rejects.toThrow();
    });
  });

  describe('email_tokens', () => {
    it('rejects an unknown purpose and a duplicate token hash', async () => {
      const role = await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
      const user = await db.client.user.create({
        data: {
          email: `token-${randomUUID().slice(0, 8)}@example.com`,
          fullName: 'Token Owner',
          passwordHash: 'placeholder-hash',
          roleId: role.id,
        },
        select: { id: true },
      });

      await expect(
        db.client.emailToken.create({
          data: {
            userId: user.id,
            purpose: 'CHANGE_EMAIL',
            tokenHash: `hash-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ).rejects.toThrow();

      const tokenHash = `hash-${randomUUID()}`;
      await db.client.emailToken.create({
        data: { userId: user.id, purpose: 'VERIFY_EMAIL', tokenHash, expiresAt: new Date(Date.now() + 60_000) },
      });

      await expect(
        db.client.emailToken.create({
          data: { userId: user.id, purpose: 'RESET_PASSWORD', tokenHash, expiresAt: new Date(Date.now() + 60_000) },
        }),
      ).rejects.toThrow();
    });
  });

  describe('domain_events', () => {
    it('rejects an event name that is not resource.action', async () => {
      await expect(db.client.domainEvent.create({ data: { name: 'UserRegistered' } })).rejects.toThrow();
      await expect(db.client.domainEvent.create({ data: { name: 'user.registered' } })).resolves.toBeTruthy();
    });
  });

  describe('the application database role', () => {
    it.skipIf(!process.env.APP_DATABASE_URL)('connects as abhyas_app and is not a superuser', async () => {
      const rows = await db.appClient.$queryRawUnsafe<Array<{ current_user: string; is_superuser: boolean }>>(
        'SELECT current_user, rolsuper AS is_superuser FROM pg_roles WHERE rolname = current_user',
      );

      expect(rows[0]?.current_user).toBe('abhyas_app');
      expect(rows[0]?.is_superuser).toBe(false);
    });

    it.skipIf(!process.env.APP_DATABASE_URL)('can append to audit_logs but cannot rewrite or erase it', async () => {
      await expect(
        db.appClient.$executeRawUnsafe(
          `INSERT INTO "audit_logs" ("action", "entity_type", "metadata") VALUES ('IDENTITY_TEST', 'user', '{}'::jsonb)`,
        ),
      ).resolves.toBe(1);

      await expect(db.appClient.$executeRawUnsafe(`UPDATE "audit_logs" SET "action" = 'TAMPERED'`)).rejects.toThrow();
      await expect(db.appClient.$executeRawUnsafe('DELETE FROM "audit_logs"')).rejects.toThrow();
    });
  });
});
