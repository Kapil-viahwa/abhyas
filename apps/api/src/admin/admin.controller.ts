import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Req } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/access';
import { requestMeta, type RequestLike } from '../auth/request';
import { AdminUsersService, type RoleChangeResult } from './users.service';

/**
 * Administration. Every route states the permission it needs; `users.read` proves the
 * matrix end to end, and `roles.write` is the first write that is ADMIN-only.
 */
@ApiTags('admin')
@Controller('v1/admin')
export class AdminController {
  constructor(@Inject(AdminUsersService) private readonly users: AdminUsersService) {}

  @RequirePermissions('users.read')
  @Get('ping')
  @ApiOperation({ summary: 'Prove the caller holds users.read' })
  @ApiOkResponse({ description: 'The caller may administer users' })
  ping(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @RequirePermissions('roles.write')
  @Patch('users/:id/role')
  @HttpCode(200)
  @ApiOperation({ summary: "Change a user's role, ending every session that user holds" })
  @ApiOkResponse({ description: 'The new role and how many sessions were revoked' })
  @ApiForbiddenResponse({ description: 'The caller does not hold roles.write' })
  async changeRole(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<RoleChangeResult> {
    return this.users.changeRole(actor, id, body, requestMeta(request));
  }
}
