import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Applies every migration to an empty schema with the Prisma CLI, then proves the
 * result is really there. Nothing about the application is trusted here.
 */

describe('migrations', () => {
  let db!: TestDatabase;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('verify');
  }, 120_000);

  afterAll(async () => {
    await db?.dispose();
  }, 60_000);

  it('records every migration and creates its tables', async () => {
    const applied = await db.client.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    );

    expect(applied.map((row) => row.migration_name)).toEqual(
      expect.arrayContaining(['20250101000000_init', '20250201000000_identity_foundation']),
    );

    const rows = await db.client.$queryRawUnsafe<Array<{ table_name: string }>>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name',
    );

    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'app_metadata',
        'audit_logs',
        'permissions',
        'roles',
        'settings',
        'user_permissions',
        'users',
      ]),
    );
  });

  it('accepts a valid app_metadata row', async () => {
    await expect(
      db.client.$executeRawUnsafe(
        'INSERT INTO "app_metadata" ("id", "key", "value", "updated_at") VALUES ($1, $2, $3, now())',
        randomUUID(),
        'phase',
        '0',
      ),
    ).resolves.toBeGreaterThan(0);
  });

  it('enforces the not-blank key constraint in the database', async () => {
    await expect(
      db.client.$executeRawUnsafe(
        'INSERT INTO "app_metadata" ("id", "key", "value", "updated_at") VALUES ($1, $2, $3, now())',
        randomUUID(),
        '   ',
        'blank key',
      ),
    ).rejects.toThrow();
  });

  it('enforces the value length constraint in the database', async () => {
    await expect(
      db.client.$executeRawUnsafe(
        'INSERT INTO "app_metadata" ("id", "key", "value", "updated_at") VALUES ($1, $2, $3, now())',
        randomUUID(),
        `too-long-${randomUUID()}`,
        'x'.repeat(1001),
      ),
    ).rejects.toThrow();
  });
});
