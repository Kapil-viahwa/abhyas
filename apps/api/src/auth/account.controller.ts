import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Authenticated, CurrentUser, type AuthenticatedUser } from './access';
import {
  AccountService,
  type DeactivatedResult,
  type OtherSessionsRevokedResult,
  type PasswordChangedResult,
  type SessionListResult,
  type SessionRevokedResult,
} from './account.service';
import { requestMeta, type RequestLike } from './request';

/**
 * The signed-in person's own account. Separate from AuthController because every
 * handler here needs a session and none of them is public.
 */
@ApiTags('account')
@Controller('v1/auth')
export class AccountController {
  constructor(@Inject(AccountService) private readonly account: AccountService) {}

  @Authenticated()
  @Get('sessions')
  @ApiOperation({ summary: 'List the live sessions of this account, current one marked' })
  @ApiOkResponse({ description: 'Device, address, last use and current marker per session' })
  @ApiUnauthorizedResponse({ description: 'No live session behind this token' })
  async listSessions(@CurrentUser() user: AuthenticatedUser): Promise<SessionListResult> {
    return this.account.listSessions(user);
  }

  @Authenticated()
  @Post('sessions/revoke-others')
  @HttpCode(200)
  @ApiOperation({ summary: 'End every other session of this account, keeping this one' })
  @ApiOkResponse({ description: 'How many sessions were ended' })
  async revokeOtherSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestLike,
  ): Promise<OtherSessionsRevokedResult> {
    return this.account.revokeOtherSessions(user, requestMeta(request));
  }

  @Authenticated()
  @Delete('sessions/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'End one of my sessions by id' })
  @ApiOkResponse({ description: 'The session no longer exists' })
  @ApiNotFoundResponse({ description: 'No such live session on this account' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: RequestLike,
  ): Promise<SessionRevokedResult> {
    return this.account.revokeSession(user, id, requestMeta(request));
  }

  @Authenticated()
  @Post('password/change')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change the password, ending every other session' })
  @ApiOkResponse({ description: 'The password changed; this session is still signed in' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<PasswordChangedResult> {
    return this.account.changePassword(user, body, requestMeta(request));
  }

  @Authenticated()
  @Post('deactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Deactivate this account, ending every session' })
  @ApiOkResponse({ description: 'The account is disabled and cannot sign in' })
  async deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<DeactivatedResult> {
    return this.account.deactivate(user, body, requestMeta(request));
  }
}
