import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/access';
import { requestMeta, type RequestLike } from '../auth/request';
import { parseUserListQuery } from '../auth/validation';
import {
  AdminUsersService,
  type RoleChangeResult,
  type UserDetail,
  type UserListResult,
} from './users.service';

/**
 * Administration.
 *
 * Every route states the permission it needs, so the matrix is enforced by the one
 * guard rather than by a role check inside a handler. An editor holds neither
 * `users.read` nor `users.write`, so every route below is a 403 for them.
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

  @RequirePermissions('users.read')
  @Get('users')
  @ApiOperation({ summary: 'Search, filter and page through accounts' })
  @ApiOkResponse({ description: 'One page of accounts with the editor capability each holds' })
  async listUsers(@Query() query: Record<string, unknown>): Promise<UserListResult> {
    return this.users.list(parseUserListQuery(query));
  }

  @RequirePermissions('users.read')
  @Get('users/:id')
  @ApiOperation({ summary: 'One account, with the sessions it currently holds' })
  @ApiOkResponse({ description: 'The account' })
  @ApiNotFoundResponse({ description: 'No such account' })
  async userDetail(@Param('id') id: string): Promise<UserDetail> {
    return this.users.detail(id);
  }

  @RequirePermissions('users.write')
  @Post('users/editors')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an editor with an explicit set of capabilities' })
  @ApiCreatedResponse({ description: 'The new editor' })
  @ApiForbiddenResponse({ description: 'The caller does not hold users.write' })
  async createEditor(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<UserDetail> {
    return this.users.createEditor(actor, body, requestMeta(request));
  }

  @RequirePermissions('users.write')
  @Patch('users/:id/editor-flags')
  @HttpCode(200)
  @ApiOperation({ summary: "Replace an editor's capabilities, ending that editor's sessions" })
  @ApiOkResponse({ description: 'The editor with the capability it now holds' })
  async updateEditorFlags(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<UserDetail> {
    return this.users.updateEditorFlags(actor, id, body, requestMeta(request));
  }

  @RequirePermissions('users.write')
  @Post('users/:id/status')
  @HttpCode(200)
  @ApiOperation({ summary: 'Activate, suspend or deactivate an account' })
  @ApiOkResponse({ description: 'The account in its new state' })
  @ApiForbiddenResponse({ description: 'The caller does not hold users.write' })
  async changeStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<UserDetail> {
    return this.users.changeStatus(actor, id, body, requestMeta(request));
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
