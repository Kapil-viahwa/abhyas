import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyPassword } from '../src/auth/password';
import { PRODUCTION_CONFIRMATION, resolveSeedAdminConfig, seedAdmin } from '../src/seed/seed-admin';
import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The seed is the one path that creates a privileged account outside the UI, so it is
 * tested against a real migrated schema: what it creates, what it refuses to create,
 * and what it records.
 */

describe('admin seed', () => {
  let db!: TestDatabase;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('seed');
  }, 120_000);

  afterAll(async () => {
    await db?.dispose();
  }, 60_000);

  function configFor(email: string, password = 'first-admin-2026') {
    return resolveSeedAdminConfig({ SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password });
  }

  it('creates the first admin with the ADMIN role, a hashed password and an audit row', async () => {
    const config = configFor('seed.admin@example.com');
    const result = await seedAdmin(db.client, config);

    expect(result.created).toBe(true);
    expect(result.outcome).toBe('created');

    const user = await db.client.user.findUniqueOrThrow({
      where: { email: 'seed.admin@example.com' },
      select: { id: true, passwordHash: true, status: true, emailVerifiedAt: true, role: { select: { code: true } } },
    });

    expect(user.role.code).toBe('ADMIN');
    expect(user.passwordHash).not.toContain(config.password);
    expect(await verifyPassword(user.passwordHash, config.password)).toBe(true);

    // Sign-in refuses an unverified address, so the account the seed creates must be
    // one the administrator can actually use.
    expect(user.status).toBe('ACTIVE');
    expect(user.emailVerifiedAt).not.toBeNull();

    const audit = await db.client.auditLog.findMany({
      where: { action: 'IDENTITY_ADMIN_SEEDED', entityId: user.id },
      select: { actorRole: true, entityType: true },
    });

    expect(audit).toHaveLength(1);
    expect(audit[0]!.entityType).toBe('user');
    expect(audit[0]!.actorRole).toBe('ADMIN');
  });

  it('is idempotent: a second run creates nothing', async () => {
    const before = await db.client.user.count();

    const result = await seedAdmin(db.client, configFor('another.admin@example.com'));

    expect(result.created).toBe(false);
    expect(result.outcome).toBe('admin-already-exists');
    expect(await db.client.user.count()).toBe(before);
  });

  it('accepts the production confirmation flag and refuses without it', () => {
    const env = {
      NODE_ENV: 'production',
      SEED_ADMIN_EMAIL: 'prod.admin@example.com',
      SEED_ADMIN_PASSWORD: 'first-admin-2026',
      SEED_ADMIN_CONFIRM: PRODUCTION_CONFIRMATION,
    };

    expect(resolveSeedAdminConfig(env).email).toBe('prod.admin@example.com');
    expect(() => resolveSeedAdminConfig({ ...env, SEED_ADMIN_CONFIRM: '' })).toThrow(
      /SEED_ADMIN_CONFIRM must be exactly/,
    );
  });
});
