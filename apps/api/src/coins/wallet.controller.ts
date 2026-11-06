import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Authenticated, CurrentUser, type AuthenticatedUser } from '../auth/access';
import { WalletService, type WalletHistoryPage, type WalletOverview } from './wallet.service';

/**
 * A student's own wallet.
 *
 * `@Authenticated` rather than `coins.write`: every signed-in account may read its own coins.
 * There is no `userId` path or query parameter — the account is the session's — so passing an
 * id changes nothing and cannot reach another person's rows.
 */
@ApiTags('coins')
@Controller('v1/coins/me')
export class WalletController {
  constructor(@Inject(WalletService) private readonly wallet: WalletService) {}

  @Authenticated()
  @Get()
  @ApiOperation({ summary: 'My balance, totals and today’s daily reward' })
  @ApiOkResponse({ description: 'Balance, total earned, total spent and the daily reward state' })
  @ApiForbiddenResponse({ description: 'The account is not active' })
  async overview(@CurrentUser() user: AuthenticatedUser): Promise<WalletOverview> {
    return this.wallet.overview(user.id);
  }

  @Authenticated()
  @Get('history')
  @ApiOperation({ summary: 'My ledger, newest first, filtered and paged' })
  @ApiOkResponse({ description: 'One page of my entries, without ids or keys' })
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
  ): Promise<WalletHistoryPage> {
    return this.wallet.history(user.id, query);
  }
}
