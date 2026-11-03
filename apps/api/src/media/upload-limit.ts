import { MAX_UPLOAD_BYTES } from './image';

/**
 * The upload route takes a base64 image in a JSON body, so its body is 4/3 of the file plus
 * the envelope. Every other route keeps the adapter's 1 MB limit; this one route gets its
 * own, and Fastify stops reading at the limit and answers 413 rather than buffering a body
 * it will refuse (decision 0045).
 */
export const UPLOAD_BODY_LIMIT_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8_192;

/** The path Nest registers for the upload, as Fastify sees it. */
export const UPLOAD_ROUTE = '/v1/media/images';

/** The slice of Fastify's route registration that the limit is set through. */
export interface RouteHookHost {
  addHook(name: 'onRoute', hook: (route: RouteOptions) => void): unknown;
}

interface RouteOptions {
  readonly method: string | string[];
  readonly url: string;
  bodyLimit?: number;
}

/**
 * Gives the upload route its own body limit. It must be attached before the routes are
 * registered — in the real entry point and in the HTTP test alike — because Fastify reads
 * `bodyLimit` when it registers the route.
 */
export function boundUploadBody(host: RouteHookHost): void {
  host.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (route.url === UPLOAD_ROUTE && methods.includes('POST')) {
      route.bodyLimit = UPLOAD_BODY_LIMIT_BYTES;
    }
  });
}
