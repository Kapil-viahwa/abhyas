import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { OtpGuard } from '../otp/otp.guard';
import { OtpThrottledException, type OtpRequestResult } from '../otp/otp.service';
import { Authenticated, CurrentUser, type AuthenticatedUser } from './access';
import {
  AccountService,
  type DeactivatedResult,
  type OtherSessionsRevokedResult,
  type PasswordChangedResult,
  type ProfileResult,
  type SessionListResult,
  type SessionRevokedResult,
} from './account.service';
import { ReauthenticationService } from './reauthentication.service';
import { requestMeta, type RequestLike } from './request';
import {
  LinkingService,
  type EmailLinked,
  type LinkAccepted,
  type MobileLinked,
  type MobileUnlinked,
} from './linking.service';

/**
 * The signed-in person's own account. Separate from AuthController because every
 * handler here needs a session and none of them is public.
 */
@ApiTags('account')
@Controller('v1/auth')
export class AccountController {
  constructor(
    @Inject(AccountService) private readonly account: AccountService,
    @Inject(ReauthenticationService) private readonly reauth: ReauthenticationService,
    @Inject(LinkingService) private readonly linking: LinkingService,
  ) {}

  /**
   * A code sent to this account's own verified number, to confirm it is still the holder
   * before a sensitive change. The destination is read from the account, never the body,
   * and with `OTP_ENABLED=false` the route answers 404 like every other OTP route.
   */
  @Authenticated()
  @UseGuards(OtpGuard)
  @Post('reauth/otp')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a re-authentication code to this account’s own mobile' })
  @ApiAcceptedResponse({ description: 'Accepted; the code goes to the number on this account' })
  @ApiBadRequestResponse({ description: 'The human check failed, or this account has no mobile' })
  @ApiTooManyRequestsResponse({ description: 'Asked too often; the answer says when to retry' })
  @ApiNotFoundResponse({ description: 'Mobile sign-in is switched off on this deployment' })
  async sendReauthCode(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OtpRequestResult> {
    try {
      return await this.reauth.sendCode(user, body, requestMeta(request));
    } catch (error) {
      if (error instanceof OtpThrottledException) {
        reply.header('retry-after', String(error.retryAfterSeconds));
      }
      throw error;
    }
  }

  /**
   * Ask to add an email address. Only an account without one can: replacing an existing
   * address would let a stolen session point password resets at another inbox.
   */
  @Authenticated()
  @Post('email/link')
  @HttpCode(202)
  @ApiOperation({ summary: 'Ask for a link that adds an email address to this account' })
  @ApiAcceptedResponse({ description: 'Accepted whether or not the address can actually be added' })
  @ApiBadRequestResponse({ description: 'The account already has an email, or the proof is wrong' })
  async requestEmailLink(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<LinkAccepted> {
    return this.linking.requestEmailLink(user, body, requestMeta(request));
  }

  @Authenticated()
  @Post('email/link/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm an email link and write the address to this account' })
  @ApiOkResponse({ description: 'The address is now this account’s and is verified' })
  @ApiBadRequestResponse({ description: 'The link is unknown, used, expired, or not this account’s' })
  async verifyEmailLink(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<EmailLinked> {
    return this.linking.verifyEmailLink(user, body, requestMeta(request));
  }

  @Authenticated()
  @UseGuards(OtpGuard)
  @Post('mobile/link')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add a verified mobile number to this account' })
  @ApiOkResponse({ description: 'The number is now this account’s verified mobile' })
  @ApiBadRequestResponse({ description: 'The code is wrong, spent or expired, or the proof is wrong' })
  @ApiNotFoundResponse({ description: 'Mobile sign-in is switched off on this deployment' })
  async linkMobile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<MobileLinked> {
    return this.linking.linkMobile(user, body, requestMeta(request));
  }

  @Authenticated()
  @UseGuards(OtpGuard)
  @Delete('mobile/link')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove the mobile number from this account' })
  @ApiOkResponse({ description: 'The number is no longer on this account' })
  @ApiBadRequestResponse({ description: 'It is the only identifier, or the proof is wrong' })
  @ApiNotFoundResponse({ description: 'Mobile sign-in is switched off on this deployment' })
  async unlinkMobile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<MobileUnlinked> {
    return this.linking.unlinkMobile(user, body, requestMeta(request));
  }

  @Authenticated()
  @Get('me')
  @ApiOperation({ summary: 'Who the caller is, with the role and the permissions currently granted' })
  @ApiOkResponse({ description: 'Profile, role code and the permission codes resolved from the database' })
  @ApiUnauthorizedResponse({ description: 'No live session behind this token' })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<ProfileResult> {
    return this.account.profile(user);
  }

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
