import 'reflect-metadata';

import type { NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import type { AppEnv } from '@abhyas/shared';

import { AppModule } from './app.module';
import { configureApiDocs } from './config/api-docs';
import { loadConfig } from './config/config';
import { trustProxyOption } from './config/trust-proxy';
import { boundUploadBody, type RouteHookHost } from './media/upload-limit';

/**
 * One place where the API is built.
 *
 * `main.ts` and the database tests both call `createApiApplication`, so a test exercises the
 * adapter options the process really uses — trustProxy, the body limit and the route hooks —
 * rather than a copy that can drift away from them (decision 0052).
 */

export const API_BODY_LIMIT_BYTES = 1_048_576;

export interface CreateApiOptions {
  /** The environment to validate. Defaults to the process's own. */
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: NestApplicationOptions['logger'];
}

export interface CreatedApi {
  readonly app: NestFastifyApplication;
  /** The validated configuration this instance booted with. */
  readonly config: AppEnv;
  /** Whether the OpenAPI document was mounted (never in production). */
  readonly docsMounted: boolean;
}

export async function createApiApplication(options: CreateApiOptions = {}): Promise<CreatedApi> {
  // Fails closed: production refuses test Turnstile keys, fake SMS and dev login.
  const config = loadConfig(options.env ?? process.env);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // A forwarded address is believed only when the proxy in front is named in TRUST_PROXY.
    // Unset means the socket address is used and any X-Forwarded-For is ignored (decision 0052).
    new FastifyAdapter({
      trustProxy: trustProxyOption(config.TRUST_PROXY),
      bodyLimit: API_BODY_LIMIT_BYTES,
    }),
    { logger: options.logger ?? ['error', 'warn', 'log'] },
  );

  app.enableShutdownHooks();

  // Every route keeps the adapter's 1 MB body limit; the base64 image upload gets its own,
  // so an oversized upload is refused with 413 before Fastify buffers it (decision 0045).
  boundUploadBody(app.getHttpAdapter().getInstance() as unknown as RouteHookHost);

  // Development and CI only: in production the OpenAPI UI and document are not mounted at
  // all, so /api/docs and /api/docs-json answer 404 (decision 0028).
  const docsMounted = configureApiDocs(app, config.NODE_ENV);

  return { app, config, docsMounted };
}
