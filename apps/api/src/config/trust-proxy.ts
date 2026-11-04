import type { FastifyServerOptions } from 'fastify';

import type { AppEnv } from '@abhyas/shared';

/**
 * `TRUST_PROXY` as Fastify's adapter option.
 *
 * A hop count is a number at runtime — `proxy-addr`, the library behind the option, accepts
 * one and reads it as "trust this many hops" — but Fastify's own typings leave the number
 * out, so the cast is confined to this one conversion. An address list arrives readonly
 * because the validated configuration is immutable, and Fastify wants a mutable array, so
 * it is copied rather than handed on.
 */
export type FastifyTrustProxy = Exclude<FastifyServerOptions['trustProxy'], undefined | null>;

export function trustProxyOption(value: AppEnv['TRUST_PROXY']): FastifyTrustProxy {
  if (typeof value === 'number') {
    return value as unknown as FastifyTrustProxy;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return value.map((entry) => String(entry));
}
