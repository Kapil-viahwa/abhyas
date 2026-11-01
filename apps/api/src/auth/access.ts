import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';

/**
 * Deny-by-default access declarations.
 *
 * A route is reachable only if it declares either @Public() or @RequirePermissions(...).
 * Routes without a declaration are refused by the guard and caught by the enumeration
 * test in route-access.spec.ts, so an undeclared endpoint cannot ship silently.
 */

export const IS_PUBLIC_KEY = 'abhyas:isPublic';
export const PERMISSIONS_KEY = 'abhyas:permissions';

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly roleCode: string;
  readonly permissions: ReadonlySet<string>;
  readonly sessionId: string;
}

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const RequirePermissions = (...codes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, codes);

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedUser => {
  const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();

  if (!request.user) {
    throw new Error('Authenticated user missing: this route is not behind the auth guard');
  }

  return request.user;
});
