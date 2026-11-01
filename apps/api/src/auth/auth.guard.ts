import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY, AUTHENTICATED_KEY, PERMISSIONS_KEY, type AuthenticatedUser } from './access';
import { PermissionsService } from './permissions.service';
import { SESSIONS_SERVICE, type SessionsService } from './sessions.service';

interface GuardedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}

function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const [scheme, value] = header.split(' ');
  if (!scheme || !value || scheme.toLowerCase() !== 'bearer') {
    return null;
  }
  return value.trim() === '' ? null : value.trim();
}

/**
 * Global, deny-by-default.
 *
 * 1. @Public() routes pass.
 * 2. A route with no declaration is refused — an undeclared endpoint is a bug.
 * 3. The access token is opaque: it is looked up by hash on the session row, so a
 *    revoked session is rejected immediately with no cache to wait on.
 * 4. Role and permissions are read from the database on every request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    // Every dependency is injected by explicit token. Nest can then build the guard
    // from the tokens alone, without relying on decorator metadata that a test
    // transformer may not emit.
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SESSIONS_SERVICE) private readonly sessions: SessionsService,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, targets);
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, targets) === true;

    if (!required && !authenticatedOnly) {
      throw new ForbiddenException('Route access is not declared');
    }

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    const session = await this.sessions.findByAccessToken(token);
    if (!session) {
      throw new UnauthorizedException('Authentication required');
    }

    const resolved = await this.permissions.resolveForUser(session.userId);
    if (!resolved) {
      throw new UnauthorizedException('Authentication required');
    }

    const missing = (required ?? []).filter((code) => !resolved.codes.has(code));
    if (missing.length > 0) {
      throw new ForbiddenException('Insufficient permissions');
    }

    request.user = {
      id: session.userId,
      email: '',
      roleCode: resolved.roleCode,
      permissions: resolved.codes,
      sessionId: session.sessionId,
    };

    return true;
  }
}
