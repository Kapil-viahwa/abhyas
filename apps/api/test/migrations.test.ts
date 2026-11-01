import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Database test: applies every migration to an empty schema using the Prisma CLI,
 * then proves the result is really there and that the DB itself enforces the
 * constraints. Nothing about the app is trusted here.
 */

const baseUrl = process.env.DATABASE_URL;

function resolveFromCwd(candidates: string[]): string {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`None of these paths exist: ${candidates.join(', ')}`);
  }
  return found;
}

function withSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

describe('migrations', () => {
  const schema = `verify_${Date.now()}_${randomUUID().slice(0, 8)}`;
  let schemaUrl = '';
  let client: PrismaClient | undefined;

  beforeAll(async () => {
    if (!baseUrl) {
      throw new Error('DATABASE_URL must be set to run the migration test');
    }

    const cwd = process.cwd();
    const prismaBin = resolveFromCwd([
      join(cwd, 'node_modules', '.bin', 'prisma'),
      join(cwd, 'apps', 'api', 'node_modules', '.bin', 'prisma'),
    ]);
    const schemaPath = resolveFromCwd([
      join(cwd, 'prisma', 'schema.prisma'),
      join(cwd, 'apps', 'api', 'prisma', 'schema.prisma'),
    ]);

    schemaUrl = withSchema(baseUrl, schema);

    // Prisma creates the target schema, but creating it explicitly keeps this test
    // independent of that behaviour.
    const bootstrap = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    try {
      await bootstrap.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    } finally {
      await bootstrap.$disconnect();
    }

    execFileSync(prismaBin, ['migrate', 'deploy', '--schema', schemaPath], {
      cwd,
      env: { ...process.env, DATABASE_URL: schemaUrl },
      stdio: 'pipe',
      encoding: 'utf8',
    });

    client = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.$disconnect();
    }
    if (baseUrl) {
      const cleanup = new PrismaClient({ datasources: { db: { url: baseUrl } } });
      try {
        await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanup.$disconnect();
      }
    }
  }, 60_000);

  it('records the migration and creates the table', async () => {
    const applied = await client!.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    );

    expect(applied.map((row) => row.migration_name)).toContain('20250101000000_init');

    const rows = await client!.$queryRawUnsafe<Array<{ table_name: string }>>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'app_metadata'",
    );

    expect(rows).toHaveLength(1);
  });

  it('accepts a valid row', async () => {
    await expect(
      client!.$executeRawUnsafe(
        'INSERT INTO "app_metadata" ("id", "key", "value", "updated_at") VALUES ($1, $2, $3, now())',
        randomUUID(),
        'phase',
        '0',
      ),
    ).resolves.toBeGreaterThan(0);
  });

  it('enforces the not-blank key constraint in the database', async () => {
    await expect(
      client!.$executeRawUnsafe(
        'INSERT INTO "app_metadata" ("id", "key", "value", "updated_at") VALUES ($1, $2, $3, now())',
        randomUUID(),
        '   ',
        'blank key',
      ),
    ).rejects.toThrow();
  });

  it('enforces the value length constraint in the database', async () => {
    await expect(
      client!.$executeRawUnsafe(
        'INSERT INTO "app_metadata" ("id", "key", "value", "updated_at") VALUES ($1, $2, $3, now())',
        randomUUID(),
        `too-long-${randomUUID()}`,
        'x'.repeat(1001),
      ),
    ).rejects.toThrow();
  });
});
