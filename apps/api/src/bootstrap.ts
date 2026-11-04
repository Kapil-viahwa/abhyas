import 'reflect-metadata';

import type { NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

import type { AppEnv } from '@abhyas/shared';

import { AppModule } from './app.module';
import { configureApiDocs } from './config/api-docs';
import { loadConfig } from './config/config';
import { headerValue, resolveClientAddress, trustProxyOption } from './config/trust-proxy';
import { boundUploadBody, type RouteHookHost } from './media/upload-limit';

/**
 * One place where the API is built.
 *
 * `main.ts` and the database tests both call `createApiApplication`, so a test exercises the
 * adapter options the process really uses — trustProxy, the body limit, the request hook and
 * the route hooks — rather than a copy that can drift away from them (decision 0052).
 */

export const API_BODY_LIMIT_BYTES = 1_048_576;

/**
 * How long the API will wait on a connection and a request (decision 0059).
 *
 * Node's defaults are no connection timeout and no request timeout, so a socket that opens
 * and says nothing, or a client that sends headers and stalls, holds a slot until something
 * else gives up. Behind Nginx that is a slow-loris lever, so all three are bounded here and
 * recorded: `connectionTimeout` bounds reading a whole request from a client, `requestTimeout`
 * bounds a request once it has started, and `keepAliveTimeout` is deliberately shorter than
 * Nginx's default 75 s so the upstream closes an idle connection before the proxy reuses it.
 */
export const API_TIMEOUTS = {
  connectionTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 72_000,
} as const;

export interface CreateApiOptions {
  /** The environment to validate. Defaults to the process's own. */
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: NestApplicationOptions['logger'];
  /** Tests only: shorten the socket timeouts so a stalled request can be proven closed. */
  readonly timeouts?: Partial<typeof API_TIMEOUTS>;
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
  const timeouts = { ...API_TIMEOUTS, ...options.timeouts };

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // A forwarded address is believed only when the proxy in front is named in TRUST_PROXY.
    // Unset means the socket address is used and any X-Forwarded-For is ignored (decision 0052).
    new FastifyAdapter({
      trustProxy: trustProxyOption(config.TRUST_PROXY),
      bodyLimit: API_BODY_LIMIT_BYTES,
      connectionTimeout: timeouts.connectionTimeoutMs,
      requestTimeout: timeouts.requestTimeoutMs,
      keepAliveTimeout: timeouts.keepAliveTimeoutMs,
    }),
    { logger: options.logger ?? ['error', 'warn', 'log'] },
  );

  app.enableShutdownHooks();

  // The client address, resolved once per request from this boot's own policy. Every
  // per-IP limit, audit row and session record reads `request.clientIp` through
  // `requestMeta`, so the policy the process booted with is the policy the request is
  // counted under — not a value a header can choose (decision 0052). Only the one header
  // the boot names is read (decision 0055).
  const instance = app.getHttpAdapter().getInstance();
  const clientIpHeader = config.TRUST_CLIENT_IP_HEADER;

  // Fastify seals its request objects, so the value is declared before a request can set it.
  instance.decorateRequest('clientIp', null);
  instance.addHook('onRequest', (request, _reply, done) => {
    (request as FastifyRequest & { clientIp: string | null }).clientIp =
      resolveClientAddress(config.TRUST_PROXY, {
        socketAddress: request.raw.socket?.remoteAddress,
        headerValue: headerValue(request.headers[clientIpHeader]),
      }) ?? null;
    done();
  });

  // Every route keeps the adapter's 1 MB body limit; the base64 image upload gets its own,
  // so an oversized upload is refused with 413 before Fastify buffers it (decision 0045).
  boundUploadBody(instance as unknown as RouteHookHost);

  // Development and CI only: in production the OpenAPI UI and document are not mounted at
  // all, so /api/docs and /api/docs-json answer 404 (decision 0028).
  const docsMounted = configureApiDocs(app, config.NODE_ENV);

  return { app, config, docsMounted };
}
