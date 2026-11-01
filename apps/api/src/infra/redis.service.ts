import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { loadConfig } from '../config/config';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor() {
    const config = loadConfig(process.env);
    this.client = new Redis(config.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      // Fail fast: a health check must not queue commands while Redis is unreachable.
      enableOfflineQueue: false,
    });
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis error: ${error.message}`);
    });
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => {
      this.client.disconnect();
    });
  }
}
