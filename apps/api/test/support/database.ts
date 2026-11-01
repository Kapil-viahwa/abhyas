import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

/**
 * Gives each database test an isolated schema with every migration applied, so tests
 * never share state and never need a second database server.
 */

export interface TestDatabase {
  readonly schema: string;
  readonly url: string;
  readonly client: PrismaClient;
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
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('DATABASE_URL must be set to run database tests');
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

  const schema = `${label}_${Date.now()}_${randomUUID().slice(0, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 60);
  const url = withSchema(baseUrl, schema);

  const bootstrap = new PrismaClient({ datasources: { db: { url: baseUrl } } });
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

  return {
    schema,
    url,
    client,
    async dispose(): Promise<void> {
      await client.$disconnect();
      const cleanup = new PrismaClient({ datasources: { db: { url: baseUrl } } });
      try {
        await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanup.$disconnect();
      }
    },
  };
}
