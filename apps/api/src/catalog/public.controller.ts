import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/access';
import { CatalogService, type PublicCatalog } from './catalog.service';

/**
 * The catalog as the public site is allowed to see it: active rows only, and no
 * inactivity hidden behind a child that is still active. No session, no token — this is
 * the endpoint the marketing pages are built from.
 */
@ApiTags('public')
@Controller('v1/public')
export class PublicCatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Public()
  @Get('catalog')
  @ApiOperation({ summary: 'Active categories and exams, for the public pages' })
  @ApiOkResponse({ description: 'The public catalog' })
  async publicCatalog(): Promise<PublicCatalog> {
    return this.catalog.publicCatalog();
  }
}
