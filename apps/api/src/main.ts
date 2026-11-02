import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { configureApiDocs } from './config/api-docs';
import { loadConfig } from './config/config';
import { boundUploadBody, type RouteHookHost } from './media/upload-limit';

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap');

  // Fails closed: production refuses test Turnstile keys, fake SMS and dev login.
  const config = loadConfig(process.env);
  logger.log(`Starting ${config.NODE_ENV} API on port ${config.PORT}`);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1_048_576 }),
    { logger: ['error', 'warn', 'log'] },
  );

  app.enableShutdownHooks();

  // Every route keeps the adapter's 1 MB body limit; the base64 image upload gets its own,
  // so an oversized upload is refused with 413 before Fastify buffers it (decision 0045).
  boundUploadBody(app.getHttpAdapter().getInstance() as unknown as RouteHookHost);

  // Development and CI only: in production the OpenAPI UI and document are not
  // mounted at all, so /api/docs and /api/docs-json answer 404 (decision 0028).
  const docsMounted = configureApiDocs(app, config.NODE_ENV);

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
