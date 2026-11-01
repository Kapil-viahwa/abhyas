import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { loadConfig } from './config/config';

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

  const openApiConfig = new DocumentBuilder()
    .setTitle('Abhyas API')
    .setDescription('Mock test platform API. Every response shape is generated from this document.')
    .setVersion('0.1.0')
    .build();

  const document = SwaggerModule.createDocument(app, openApiConfig);
  // Serves the UI at /api/docs and the machine-readable document at /api/docs-json.
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(config.PORT, '0.0.0.0');
  logger.log(`API listening on http://0.0.0.0:${config.PORT} (docs at /api/docs)`);
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`Abhyas API failed to boot:\n${message}`);
  process.exit(1);
});
