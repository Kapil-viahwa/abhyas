import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Authenticated, CurrentUser, Public, type AuthenticatedUser } from './access';
import {
  AuthService,
  type LoginResult,
  type LogoutResult,
  type RegisterResult,
  type RequestMetadata,
  type VerifyEmailResult,
} from './auth.service';

/** What the controller needs from the request, without importing a server type. */
interface RequestLike {
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function requestMeta(request: RequestLike): RequestMetadata {
  const agent = request.headers['user-agent'];

  return {
    ip: request.ip,
    userAgent: typeof agent === 'string' ? agent : undefined,
  };
}

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
  @ApiBadRequestResponse({ description: 'The body or the human verification failed' })
  @ApiUnauthorizedResponse({ description: 'The same body for an unknown address and a wrong password' })
  @ApiForbiddenResponse({ description: 'The account is deactivated, or its email is not verified' })
  async login(@Body() body: unknown, @Req() request: RequestLike): Promise<LoginResult> {
    return this.auth.login(body, requestMeta(request));
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
}
