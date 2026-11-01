import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthGuard } from './auth/auth.guard';
import { PermissionsService } from './auth/permissions.service';
import { SESSIONS_SERVICE, SessionsService } from './auth/sessions.service';
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
    SessionsService,
    { provide: SESSIONS_SERVICE, useExisting: SessionsService },
    PermissionsService,
    // Deny-by-default everywhere: the guard refuses any route without a declaration.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
