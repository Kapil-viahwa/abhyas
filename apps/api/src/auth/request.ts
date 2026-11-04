import { isIP } from 'node:net';

/**
 * What a controller needs from the request, without importing a server type.
 *
 * Every client address the platform counts by, stores or logs passes through here first.
 * A forwarding header is whatever the edge — or a browser pretending to be one — wrote, so
 * a value that is not a single IP address is dropped rather than carried into a Redis key,
 * an audit row or a log line (decision 0052).
 */
export interface RequestLike {
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface RequestMetadata {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

/** The address, or `undefined` for anything that is not exactly one IPv4 or IPv6 address. */
export function clientAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const candidate = value.trim();

  return candidate !== '' && isIP(candidate) !== 0 ? candidate : undefined;
}

export function requestMeta(request: RequestLike): RequestMetadata {
  const agent = request.headers['user-agent'];

  return {
    ip: clientAddress(request.ip),
    userAgent: typeof agent === 'string' ? agent : undefined,
  };
}
