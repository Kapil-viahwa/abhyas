import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Public } from '../auth/access';
import type { LoginResult } from '../auth/auth.service';
import { MOBILE_ALREADY_REGISTERED_MESSAGE, MobileIdentityService } from '../auth/mobile.service';
import { requestMeta, type RequestLike } from '../auth/request';
import { parseOtpRequestBody } from '../auth/validation';
import { OtpGuard } from './otp.guard';
import { OtpService, OtpThrottledException, type OtpRequestResult } from './otp.service';

/**
 * The three mobile entry points.
 *
 * The whole controller sits behind `OtpGuard`, so with `OTP_ENABLED=false` every route here
 * answers 404 — the same answer as a route that was never deployed. The screens are hidden
 * as well, but the server refusing is what makes the switch a switch (decision 0048).
 */
@ApiTags('auth')
@Controller('v1/auth')
@UseGuards(OtpGuard)
export class OtpController {
  constructor(
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(MobileIdentityService) private readonly mobile: MobileIdentityService,
  ) {}

  @Public()
  @Post('otp')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a six-digit code to a mobile number' })
  @ApiAcceptedResponse({ description: 'Accepted whether or not the number has an account' })
  @ApiBadRequestResponse({ description: 'The number, the country or the human check failed' })
  @ApiTooManyRequestsResponse({ description: 'This number, address or device asked too often' })
  @ApiNotFoundResponse({ description: 'Mobile sign-in is switched off on this deployment' })
  async requestCode(
    @Body() body: unknown,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OtpRequestResult> {
    try {
      return await this.otp.requestCode(parseOtpRequestBody(body), requestMeta(request));
    } catch (error) {
      if (error instanceof OtpThrottledException) {
        // The client's resend timer reads this, so it never has to guess.
        reply.header('retry-after', String(error.retryAfterSeconds));
      }
      throw error;
    }
  }

  @Public()
  @Post('mobile/register')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an account from a verified mobile number, signed in' })
  @ApiCreatedResponse({ description: 'The account, with the session password sign-in issues' })
  @ApiBadRequestResponse({ description: 'The code is wrong, expired or spent; the human check failed' })
  @ApiConflictResponse({ description: MOBILE_ALREADY_REGISTERED_MESSAGE })
  @ApiNotFoundResponse({ description: 'Mobile sign-in is switched off on this deployment' })
  async register(@Body() body: unknown, @Req() request: RequestLike): Promise<LoginResult> {
    return this.mobile.register(body, requestMeta(request));
  }

  @Public()
  @Post('mobile/login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with a mobile number and a code' })
  @ApiOkResponse({ description: 'The access token, the refresh token and who signed in' })
  @ApiBadRequestResponse({ description: 'The code is wrong, expired or spent' })
  @ApiUnauthorizedResponse({ description: 'The code is right but no account owns that number' })
  @ApiNotFoundResponse({ description: 'Mobile sign-in is switched off on this deployment' })
  async login(@Body() body: unknown, @Req() request: RequestLike): Promise<LoginResult> {
    return this.mobile.login(body, requestMeta(request));
  }
}
