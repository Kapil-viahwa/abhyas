import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Authenticated, CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/access';
import { requestMeta, type RequestLike } from '../auth/request';
import { parseUuid } from '../auth/validation';
import { MediaService, type MediaAssetResult, type SignedUrlResult } from './media.service';
import type { FastifyReply } from 'fastify';

/** How long a refused upload is told to wait before it is worth trying again. */
const RETRY_AFTER_SECONDS = '1';

/**
 * Question media. Uploading needs `content.write` (the editor's manage-questions flag);
 * reading needs only a session, and the service decides whether this person may see the
 * image at all.
 */
@ApiTags('media')
@Controller('v1/media')
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}

  @RequirePermissions('content.write')
  @Post('images')
  @HttpCode(201)
  @ApiOperation({ summary: 'Upload an image for a question' })
  @ApiCreatedResponse({ description: 'The stored image, re-encoded and stripped of metadata' })
  @ApiBadRequestResponse({ description: 'Not an allowed image, too large, or corrupt' })
  @ApiForbiddenResponse({ description: 'The caller cannot author content' })
  @ApiServiceUnavailableResponse({ description: 'The decode queue is full, or the store is unreachable' })
  async upload(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MediaAssetResult> {
    try {
      return await this.media.upload(actor, body, requestMeta(request));
    } catch (error) {
      // A busy decode queue is not a failure of the request: say when to come back.
      if (error instanceof ServiceUnavailableException) {
        reply.header('retry-after', RETRY_AFTER_SECONDS);
      }
      throw error;
    }
  }

  @Authenticated()
  @Get('images/:id/url')
  @HttpCode(200)
  @ApiOperation({ summary: 'A short-lived signed URL for an image this caller may see' })
  @ApiOkResponse({ description: 'The URL and how long it lives' })
  @ApiNotFoundResponse({ description: 'No such image, or it belongs to somebody else' })
  @ApiServiceUnavailableResponse({ description: 'The object store is not reachable' })
  async signedUrl(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<SignedUrlResult> {
    return this.media.signedUrl(actor, parseUuid(id, 'image id'));
  }
}
