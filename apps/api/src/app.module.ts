import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { DatabaseService } from './infra/database.service';
import { RedisService } from './infra/redis.service';
import { DATABASE_PROBE, REDIS_PROBE } from './infra/tokens';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: DATABASE_PROBE, useClass: DatabaseService },
    { provide: REDIS_PROBE, useClass: RedisService },
    HealthService,
  ],
})
export class AppModule {}
