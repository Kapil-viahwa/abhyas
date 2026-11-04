import 'reflect-metadata';

import { Logger } from '@nestjs/common';

import { createApiApplication } from './bootstrap';

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap');

  // Fails closed, and wires the adapter the tests also use: `createApiApplication` refuses a
  // production environment with test Turnstile keys, fake SMS or dev login (decision 0028).
  const { app, config, docsMounted } = await createApiApplication();

  logger.log(`Starting ${config.NODE_ENV} API on port ${config.PORT}`);

  await app.listen(config.PORT, '0.0.0.0');
  logger.log(
    `API listening on http://0.0.0.0:${config.PORT}${docsMounted ? ' (docs at /api/docs)' : ' (API docs disabled)'}`,
  );
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`Abhyas API failed to boot:\n${message}`);
  process.exit(1);
});
