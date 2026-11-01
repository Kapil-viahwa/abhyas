import {
  Body,
  Controller,
  Get,
  Header,
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
import { AuditService, type AuditPage } from './audit.service';
import { DashboardService, type DashboardCounts } from './dashboard.service';
import { parseAuditQuery } from './operations.validation';
import { SettingsService, type SettingRow } from './settings.service';
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
 * guard rather than by a role check inside a handler. An editor holds none of these
 * permissions, so every route below is a 403 for them.
 */
@ApiTags('admin')
@Controller('v1/admin')
export class AdminController {
  constructor(
    @Inject(AdminUsersService) private readonly users: AdminUsersService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DashboardService) private readonly dashboard: DashboardService,
  ) {}

  @RequirePermissions('users.read')
  @Get('ping')
  @ApiOperation({ summary: 'Prove the caller holds users.read' })
  @ApiOkResponse({ description: 'The caller may administer users' })
  ping(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @RequirePermissions('users.read')
  @Get('dashboard')
  @ApiOperation({ summary: 'Real counts of what the platform holds today' })
  @ApiOkResponse({ description: 'Users, editors, live sessions, categories and exams' })
  async dashboardCounts(): Promise<DashboardCounts> {
    return this.dashboard.counts();
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

  @RequirePermissions('settings.read')
  @Get('settings')
  @ApiOperation({ summary: 'Every platform setting, with its type and bounds' })
  @ApiOkResponse({ description: 'The settings as the platform stores them' })
  async listSettings(): Promise<{ settings: readonly SettingRow[] }> {
    return { settings: await this.settings.list() };
  }

  @RequirePermissions('settings.write')
  @Patch('settings/:key')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change one setting, within the bounds the row carries' })
  @ApiOkResponse({ description: 'The setting as it now stands' })
  @ApiForbiddenResponse({ description: 'The caller does not hold settings.write' })
  async updateSetting(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<SettingRow> {
    return this.settings.update(actor, key, body, requestMeta(request));
  }

  @RequirePermissions('audit.read')
  @Get('audit')
  @ApiOperation({ summary: 'Search the audit trail by actor, action and date range' })
  @ApiOkResponse({ description: 'One page of audit rows, newest first' })
  async searchAudit(@Query() query: Record<string, unknown>): Promise<AuditPage> {
    return this.audit.search(parseAuditQuery(query));
  }

  @RequirePermissions('audit.read')
  @Get('audit/export')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="abhyas-audit.csv"')
  @ApiOperation({ summary: 'Export what the same filters show as CSV; the export is audited' })
  @ApiOkResponse({ description: 'A CSV document' })
  async exportAudit(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
    @Req() request: RequestLike,
  ): Promise<string> {
    const result = await this.audit.exportCsv(actor, parseAuditQuery(query), requestMeta(request));
    return result.csv;
  }
}
