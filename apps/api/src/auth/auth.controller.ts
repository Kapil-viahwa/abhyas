import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Authenticated, CurrentUser, Public, type AuthenticatedUser } from './access';
import {
  AuthService,
  type ForgotPasswordResult,
  type LoginResult,
  type LogoutResult,
  type RefreshResult,
  type RegisterResult,
  type ResetPasswordResult,
  type VerifyEmailResult,
} from './auth.service';
import { requestMeta, type RequestLike } from './request';

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(202)
  @ApiOperation({ summary: 'Create an account and send a verification email' })
  @ApiAcceptedResponse({ description: 'Accepted whether or not the address is already registered' })
  @ApiBadRequestResponse({ description: 'The body, the password, or the human verification failed' })
  async register(@Body() body: unknown, @Req() request: RequestLike): Promise<RegisterResult> {
    return this.auth.register(body, requestMeta(request));
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm an email address with the token from the verification mail' })
  @ApiOkResponse({ description: 'The address is verified' })
  @ApiBadRequestResponse({ description: 'The token is unknown, already used or expired' })
  async verifyEmail(@Body() body: unknown, @Req() request: RequestLike): Promise<VerifyEmailResult> {
    return this.auth.verifyEmail(body, requestMeta(request));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange an email and password for an opaque session token' })
  @ApiOkResponse({ description: 'The access token, the refresh token and who signed in' })
  @ApiBadRequestResponse({ description: 'The body is not valid' })
  @ApiUnauthorizedResponse({ description: 'The same body for an unknown address and a wrong password' })
  @ApiForbiddenResponse({ description: 'The account is deactivated, or its email is not verified' })
  @ApiTooManyRequestsResponse({ description: 'This address has guessed at this account too often' })
  async login(@Body() body: unknown, @Req() request: RequestLike): Promise<LoginResult> {
    return this.auth.login(body, requestMeta(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate a refresh token into a fresh access and refresh pair' })
  @ApiOkResponse({ description: 'A new pair; the presented refresh token is now dead' })
  @ApiUnauthorizedResponse({ description: 'The token is unknown, expired, or already rotated (family revoked)' })
  async refresh(@Body() body: unknown, @Req() request: RequestLike): Promise<RefreshResult> {
    return this.auth.refresh(body, requestMeta(request));
  }

  @Authenticated()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke the session behind this access token, immediately' })
  @ApiOkResponse({ description: 'The session no longer exists' })
  @ApiUnauthorizedResponse({ description: 'The token was already revoked or expired' })
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() request: RequestLike): Promise<LogoutResult> {
    return this.auth.logout(user, requestMeta(request));
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  @ApiOperation({ summary: 'Ask for a password reset link' })
  @ApiAcceptedResponse({ description: 'Accepted whether or not the address is registered' })
  @ApiBadRequestResponse({ description: 'The body or the human verification failed' })
  @ApiTooManyRequestsResponse({ description: 'Too many reset requests from this address or for this account' })
  async forgotPassword(@Body() body: unknown, @Req() request: RequestLike): Promise<ForgotPasswordResult> {
    return this.auth.forgotPassword(body, requestMeta(request));
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set a new password with a reset token, ending every session' })
  @ApiOkResponse({ description: 'The password changed and every session was revoked' })
  @ApiBadRequestResponse({ description: 'The token is unknown, already used, expired, or the password is weak' })
  async resetPassword(@Body() body: unknown, @Req() request: RequestLike): Promise<ResetPasswordResult> {
    return this.auth.resetPassword(body, requestMeta(request));
  }
}
