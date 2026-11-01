import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Proves the phase 1 constraints by attempting the violation and watching the
 * database reject it. Every test here is about behaviour the application cannot
 * accidentally bypass.
 *
 * Prisma binds string parameters as text, so UUID columns are cast explicitly.
 */

describe('identity foundation', () => {
  let db!: TestDatabase;
  let adminRoleId!: string;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('identity');
    const roles = await db.client.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "roles" WHERE "code" = $1',
      'ADMIN',
    );
    adminRoleId = roles[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.dispose();
  }, 60_000);

  async function insertUser(options: { email: string; mobile?: string | null }): Promise<string> {
    const id = randomUUID();
    await db.client.$executeRawUnsafe(
      'INSERT INTO "users" ("id", "email", "mobile", "password_hash", "full_name", "role_id") VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)',
      id,
      options.email,
      options.mobile ?? null,
      'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
      'Test User',
      adminRoleId,
    );
    return id;
  }

  it('seeds the three system roles and the permission catalog', async () => {
    const roles = await db.client.$queryRawUnsafe<Array<{ code: string }>>(
      'SELECT "code" FROM "roles" ORDER BY "code"',
    );
    expect(roles.map((row) => row.code)).toEqual(['ADMIN', 'EDITOR', 'USER']);

    const permissions = await db.client.$queryRawUnsafe<Array<{ code: string }>>(
      'SELECT "code" FROM "permissions" ORDER BY "code"',
    );
    const codes = permissions.map((row) => row.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'users.read',
        'users.write',
        'roles.write',
        'permissions.assign',
        'coins.adjust',
        'settings.write',
        'tests.publish',
        'attempts.take',
      ]),
    );
  });

  it('stores the email normalised and rejects a duplicate that differs only by case', async () => {
    const local = `student-${randomUUID().slice(0, 8)}`;
    await insertUser({ email: `  ${local}@Example.COM  ` });

    const stored = await db.client.$queryRawUnsafe<Array<{ email: string }>>(
      'SELECT "email" FROM "users" WHERE "email" = $1',
      `${local}@example.com`,
    );
    expect(stored).toHaveLength(1);

    await expect(insertUser({ email: `${local.toUpperCase()}@ExAmPlE.com` })).rejects.toThrow();
  });

  it('normalises a mobile number and rejects a duplicate in another format', async () => {
    const suffix = String(Math.floor(Math.random() * 90_000_000) + 10_000_000);
    const id = await insertUser({
      email: `mobile-${randomUUID().slice(0, 8)}@example.com`,
      mobile: `+91 98765 ${suffix.slice(0, 5)}`,
    });

    const stored = await db.client.$queryRawUnsafe<Array<{ mobile: string | null }>>(
      'SELECT "mobile" FROM "users" WHERE "id" = $1::uuid',
      id,
    );
    expect(stored[0]!.mobile).toMatch(/^[0-9]{10}$/);
    expect(stored[0]!.mobile).not.toContain('+');

    const digits = stored[0]!.mobile!;
    await expect(
      insertUser({ email: `mobile-dup-${randomUUID().slice(0, 8)}@example.com`, mobile: `0${digits}` }),
    ).rejects.toThrow();
  });

  it('rejects a mobile that is not ten digits after normalisation', async () => {
    await expect(
      insertUser({ email: `short-${randomUUID().slice(0, 8)}@example.com`, mobile: '12345' }),
    ).rejects.toThrow();
  });

  it('rejects an email that is not an email address', async () => {
    await expect(insertUser({ email: 'not-an-email' })).rejects.toThrow();
  });

  it('rejects an integer setting outside its bounds', async () => {
    await expect(
      db.client.$executeRawUnsafe(
        'INSERT INTO "settings" ("key", "value_type", "value_int", "min_int", "max_int") VALUES ($1, $2, $3, $4, $5)',
        'coins.bounded_test',
        'integer',
        500,
        0,
        200,
      ),
    ).rejects.toThrow();
  });

  it('accepts an integer setting inside its bounds', async () => {
    await expect(
      db.client.$executeRawUnsafe(
        'INSERT INTO "settings" ("key", "value_type", "value_int", "min_int", "max_int") VALUES ($1, $2, $3, $4, $5)',
        'coins.bounded_test_ok',
        'integer',
        150,
        0,
        200,
      ),
    ).resolves.toBeGreaterThan(0);
  });

  it('rejects a setting whose value does not match its declared type', async () => {
    await expect(
      db.client.$executeRawUnsafe(
        'INSERT INTO "settings" ("key", "value_type", "value_bool") VALUES ($1, $2, $3)',
        'coins.type_mismatch',
        'integer',
        true,
      ),
    ).rejects.toThrow();

    await expect(
      db.client.$executeRawUnsafe(
        'INSERT INTO "settings" ("key", "value_type", "value_text") VALUES ($1, $2, $3)',
        'coins.blank_text',
        'string',
        '',
      ),
    ).rejects.toThrow();
  });

  it('rejects an update and a delete on the audit log', async () => {
    const id = randomUUID();
    await db.client.$executeRawUnsafe(
      'INSERT INTO "audit_logs" ("id", "action", "entity_type") VALUES ($1::uuid, $2, $3)',
      id,
      'IDENTITY_TEST',
      'user',
    );

    await expect(
      db.client.$executeRawUnsafe('UPDATE "audit_logs" SET "action" = $1 WHERE "id" = $2::uuid', 'CHANGED', id),
    ).rejects.toThrow(/append-only/);

    await expect(
      db.client.$executeRawUnsafe('DELETE FROM "audit_logs" WHERE "id" = $1::uuid', id),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses audit updates and deletes for the application role, which may only read and append', async () => {
    const id = randomUUID();
    await db.client.$executeRawUnsafe(
      'INSERT INTO "audit_logs" ("id", "action") VALUES ($1::uuid, $2)',
      id,
      'IDENTITY_TEST',
    );

    await expect(
      db.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET ROLE "abhyas_app"');
        await tx.$executeRawUnsafe(
          'UPDATE "audit_logs" SET "action" = $1 WHERE "id" = $2::uuid',
          'CHANGED',
          id,
        );
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET ROLE "abhyas_app"');
        await tx.$executeRawUnsafe('DELETE FROM "audit_logs" WHERE "id" = $1::uuid', id);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('lets the application role append and read audit rows', async () => {
    const id = randomUUID();

    const inserted = await db.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET ROLE "abhyas_app"');
      await tx.$executeRawUnsafe(
        'INSERT INTO "audit_logs" ("id", "action") VALUES ($1::uuid, $2)',
        id,
        'IDENTITY_APPEND_OK',
      );
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "audit_logs" WHERE "id" = $1::uuid',
        id,
      );
      return rows.length;
    });

    expect(inserted).toBe(1);
  });

  it('refuses a permission override granted by the user to themselves', async () => {
    const userId = await insertUser({ email: `self-${randomUUID().slice(0, 8)}@example.com` });
    const permissions = await db.client.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "permissions" WHERE "code" = $1',
      'users.read',
    );

    await expect(
      db.client.$executeRawUnsafe(
        'INSERT INTO "user_permissions" ("user_id", "permission_id", "granted_by") VALUES ($1::uuid, $2::uuid, $3::uuid)',
        userId,
        permissions[0]!.id,
        userId,
      ),
    ).rejects.toThrow();
  });

  it('rejects a second identical permission grant', async () => {
    const userId = await insertUser({ email: `grant-${randomUUID().slice(0, 8)}@example.com` });
    const permissions = await db.client.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "permissions" WHERE "code" = $1',
      'coins.read',
    );

    await db.client.$executeRawUnsafe(
      'INSERT INTO "user_permissions" ("user_id", "permission_id") VALUES ($1::uuid, $2::uuid)',
      userId,
      permissions[0]!.id,
    );

    await expect(
      db.client.$executeRawUnsafe(
        'INSERT INTO "user_permissions" ("user_id", "permission_id") VALUES ($1::uuid, $2::uuid)',
        userId,
        permissions[0]!.id,
      ),
    ).rejects.toThrow();
  });
});
