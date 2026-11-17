import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

/**
 * Gives each database test an isolated schema with every migration applied, so tests
 * never share state and never need a second database server.
 *
 * Migrations are applied by the owner connection (MIGRATION_DATABASE_URL, falling back
 * to DATABASE_URL). The application-role client (APP_DATABASE_URL) is the connection
 * the API really uses, so tests can prove what that role may and may not do.
 */

export interface TestDatabase {
  readonly schema: string;
  /** Owner connection: migrations, fixtures, assertions about data. */
  readonly url: string;
  readonly client: PrismaClient;
  /** Application-role connection: used to prove privileges, not to set data up. */
  readonly appUrl: string;
  readonly appClient: PrismaClient;
  readonly hasAppRole: boolean;
  dispose(): Promise<void>;
}

function resolveFromCwd(candidates: string[]): string {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`None of these paths exist: ${candidates.join(', ')}`);
  }
  return found;
}

export function withSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

export async function createMigratedTestDatabase(label: string): Promise<TestDatabase> {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!migrationUrl) {
    throw new Error('DATABASE_URL or MIGRATION_DATABASE_URL must be set to run database tests');
  }

  const appBaseUrl = process.env.APP_DATABASE_URL;
  const hasAppRole = typeof appBaseUrl === 'string' && appBaseUrl.trim() !== '';

  const cwd = process.cwd();
  const prismaBin = resolveFromCwd([
    join(cwd, 'node_modules', '.bin', 'prisma'),
    join(cwd, 'apps', 'api', 'node_modules', '.bin', 'prisma'),
  ]);
  const schemaPath = resolveFromCwd([
    join(cwd, 'prisma', 'schema.prisma'),
    join(cwd, 'apps', 'api', 'prisma', 'schema.prisma'),
  ]);

  const schema = `${label}_${Date.now()}_${randomUUID().slice(0, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 60);
  const url = withSchema(migrationUrl, schema);
  const appUrl = hasAppRole ? withSchema(appBaseUrl as string, schema) : url;

  const bootstrap = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  try {
    await bootstrap.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await bootstrap.$disconnect();
  }

  execFileSync(prismaBin, ['migrate', 'deploy', '--schema', schemaPath], {
    cwd,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
    encoding: 'utf8',
  });

  const client = new PrismaClient({ datasources: { db: { url } } });
  const appClient = hasAppRole ? new PrismaClient({ datasources: { db: { url: appUrl } } }) : client;

  return {
    schema,
    url,
    client,
    appUrl,
    appClient,
    hasAppRole,
    async dispose(): Promise<void> {
      await client.$disconnect();
      if (appClient !== client) {
        await appClient.$disconnect();
      }
      const cleanup = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
      try {
        await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanup.$disconnect();
      }
    },
  };
}


/**
 * Publishes a draft paper the way `TestsService.publish` does: every placement is pinned to its
 * question's current version first, then the version is stamped, then the test itself moves to
 * `PUBLISHED` (A5b). The order matters — `test_versions_pinned_before_publish` refuses a paper that
 * still has an unpinned row, and `test_questions_frozen` refuses a placement written into a
 * published version. The last statement is what lets the paper be archived and listed as live.
 */
export async function publishTestVersion(client: PrismaClient, versionId: string): Promise<void> {
  await client.$executeRawUnsafe(
    `UPDATE "test_questions" tq
       SET "question_version_id" = qv."id"
      FROM "questions" q, "question_versions" qv
      WHERE qv."question_id" = q."id"
        AND qv."version" = q."current_version"
        AND tq."question_id" = q."id"
        AND tq."test_version_id" = $1::uuid
        AND tq."question_version_id" IS NULL`,
    versionId,
  );

  await client.$executeRawUnsafe(
    `UPDATE "test_versions" SET "published_at" = now() WHERE "id" = $1::uuid`,
    versionId,
  );

  await client.$executeRawUnsafe(
    `UPDATE "tests" SET "status" = 'PUBLISHED', "published_at" = COALESCE("published_at", now())
      WHERE "id" = (SELECT "test_id" FROM "test_versions" WHERE "id" = $1::uuid)`,
    versionId,
  );
}
