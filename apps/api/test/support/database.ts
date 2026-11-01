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
