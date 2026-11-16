import { NotFoundException } from '@nestjs/common';
import { parseAllowedAddress, type AllowedAddress } from '@abhyas/shared';

import {
  addressAllowed,
  INTERNAL_FAILURE_LIMIT,
  INTERNAL_FAILURE_WINDOW_SECONDS,
  internalFailureKey,
  secretMatches,
} from '../coins/internal-access';
import { loadConfig } from '../config/config';
import type { RedisService } from '../infra/redis.service';
import { requestMeta, type RequestLike } from '../auth/request';

/**
 * The one door the worker knocks on, shared by every internal route.
 *
 * It has three locks: its own secret (`INTERNAL_API_SECRET`, never the cache-revalidation one),
 * a list of source addresses that production writes explicitly, and a per-address failure
 * counter so a wrong secret cannot be guessed quickly. A refusal is a 404 rather than a 401, so
 * a route does not confirm that it exists. Extracted from the bulk-coin controller so the
 * attempt sweeper is guarded by the exact same code, not a copy of it.
 */
export async function assertInternalRequest(request: RequestLike, redisService: RedisService): Promise<void> {
  const config = loadConfig(process.env);
  const address = requestMeta(request).ip;
  const networks: AllowedAddress[] = config.INTERNAL_ALLOWED_ADDRESSES.map((entry) =>
    parseAllowedAddress(entry),
  ).filter((entry): entry is AllowedAddress => entry !== null);

  if (!addressAllowed(networks, address)) {
    throw new NotFoundException();
  }

  const failuresKey = internalFailureKey(address);
  const failures = Number((await redisService.redis.get(failuresKey)) ?? '0');

  if (failures >= INTERNAL_FAILURE_LIMIT) {
    throw new NotFoundException();
  }

  if (!secretMatches(request.headers['x-internal-secret'], config.INTERNAL_API_SECRET)) {
    await redisService.redis
      .multi()
      .incr(failuresKey)
      .expire(failuresKey, INTERNAL_FAILURE_WINDOW_SECONDS)
      .exec();
    throw new NotFoundException();
  }
}
