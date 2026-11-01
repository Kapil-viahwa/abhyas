import { PrismaClient } from '@prisma/client';

import { resolveSeedAdminConfig, seedAdmin, SeedConfigError } from './seed-admin';

/**
 * CLI entry point. Run with `pnpm db:seed:admin` after a build; it refuses to run
 * without explicit variables and never falls back to a default password.
 */

async function main(): Promise<void> {
  const config = resolveSeedAdminConfig(process.env);
  const client = new PrismaClient();

  try {
    const result = await seedAdmin(client, config);

    if (result.created) {
      // eslint-disable-next-line no-console
      console.log(`Created the first administrator ${config.email} (${result.userId}).`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`No administrator created: ${result.outcome}.`);
    }
  } finally {
    await client.$disconnect();
  }
}

void main().catch((error: unknown) => {
  if (error instanceof SeedConfigError) {
    // eslint-disable-next-line no-console
    console.error(error.message);
  } else {
    // eslint-disable-next-line no-console
    console.error('Admin seed failed:', error);
  }
  process.exit(1);
});
