import { PrismaClient } from '@prisma/client';

import { CatalogSeedError, findSeedActor, seedCatalog } from './catalog';

/**
 * Seeds the example catalog. Run with `pnpm db:seed:catalog` after building.
 *
 * It never runs automatically: not on boot, not in a migration, and in production it
 * refuses without `CATALOG_SEED_CONFIRM=seed-example-catalog`.
 */

async function main(): Promise<void> {
  const client = new PrismaClient();

  try {
    const actor = await findSeedActor(client);
    const result = await seedCatalog(client, {
      createdBy: actor.id,
      nodeEnv: process.env.NODE_ENV ?? 'development',
      confirm: process.env.CATALOG_SEED_CONFIRM,
    });

    // eslint-disable-next-line no-console
    console.log(
      `Catalog seeded as ${actor.email}: ${result.categories} categories, ${result.exams} exams, ${result.subjects} subjects created (existing rows left alone).`,
    );
  } finally {
    await client.$disconnect();
  }
}

void main().catch((error: unknown) => {
  if (error instanceof CatalogSeedError) {
    // eslint-disable-next-line no-console
    console.error(error.message);
  } else {
    // eslint-disable-next-line no-console
    console.error('Catalog seed failed:', error);
  }
  process.exit(1);
});
