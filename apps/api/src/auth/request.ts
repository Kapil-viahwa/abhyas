/** What a controller needs from the request, without importing a server type. */
export interface RequestLike {
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface RequestMetadata {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export function requestMeta(request: RequestLike): RequestMetadata {
  const agent = request.headers['user-agent'];

  return {
    ip: request.ip,
    userAgent: typeof agent === 'string' ? agent : undefined,
  };
}
