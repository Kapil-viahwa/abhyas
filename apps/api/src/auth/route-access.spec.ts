import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { AdminController } from '../admin/admin.controller';
import { HealthController } from '../health/health.controller';
import { IS_PUBLIC_KEY, AUTHENTICATED_KEY, PERMISSIONS_KEY } from './access';
import { AuthController } from './auth.controller';

/**
 * Every controller the application module registers. Adding a controller means adding
 * it here, so the registry cannot silently fall behind. The test then refuses any route
 * handler that declares neither @Public(), @Authenticated() nor @RequirePermissions(...).
 */
export const HTTP_CONTROLLERS = [HealthController, AuthController, AdminController];

type Handler = (...args: never[]) => unknown;

describe('route access declarations', () => {
  it('covers every route handler with an explicit declaration', () => {
    const undeclared: string[] = [];
    let routes = 0;

    for (const controller of HTTP_CONTROLLERS) {
      const basePath = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
      const prototype = controller.prototype as unknown as Record<string, Handler | undefined>;

      for (const key of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[key];
        if (typeof handler !== 'function') {
          continue;
        }

        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) {
          continue;
        }

        routes += 1;

        const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
        const isAuthenticatedOnly = Reflect.getMetadata(AUTHENTICATED_KEY, handler) === true;
        const permissions = Reflect.getMetadata(PERMISSIONS_KEY, handler) as string[] | undefined;
        const declared =
          isPublic || isAuthenticatedOnly || (Array.isArray(permissions) && permissions.length > 0);

        if (!isPublic && permissions !== undefined && permissions.length === 0 && !isAuthenticatedOnly) {
          undeclared.push(`${controller.name}.${key} declares an empty permission list`);
        } else if (!declared) {
          undeclared.push(`${controller.name}.${key} (${basePath || '/'})`);
        }
      }
    }

    expect(routes).toBeGreaterThan(0);
    expect(undeclared).toEqual([]);
  });
});
