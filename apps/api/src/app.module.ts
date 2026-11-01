import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AdminController } from './admin/admin.controller';
import { AuditService } from './admin/audit.service';
import { DashboardService } from './admin/dashboard.service';
import { SettingsService } from './admin/settings.service';
import { AdminUsersService } from './admin/users.service';
import { AccountController } from './auth/account.controller';
import { AccountService } from './auth/account.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { PermissionsService } from './auth/permissions.service';
import { SESSIONS_SERVICE, SessionsService } from './auth/sessions.service';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { PublicCatalogController } from './catalog/public.controller';
import { CatalogRevalidationService } from './catalog/revalidation.service';
import { loadConfig } from './config/config';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { DatabaseService } from './infra/database.service';
import { EMAIL_SENDER, createEmailSender } from './infra/email-sender';
import { RateLimiter } from './infra/rate-limiter';
import { RedisService } from './infra/redis.service';
import { DATABASE_PROBE, REDIS_PROBE } from './infra/tokens';
import { TURNSTILE_VERIFIER, createTurnstileVerifier } from './infra/turnstile-verifier';

@Module({
  controllers: [HealthController, AuthController, AccountController, AdminController, CatalogController, PublicCatalogController],
  providers: [
    { provide: DATABASE_PROBE, useClass: DatabaseService },
    { provide: REDIS_PROBE, useClass: RedisService },
    HealthService,
    SessionsService,
    { provide: SESSIONS_SERVICE, useExisting: SessionsService },
    PermissionsService,
    // Both factories run at boot, so a development shortcut that cannot exist in
    // production stops the process before it accepts a request.
    {
      provide: EMAIL_SENDER,
      useFactory: () => {
        const config = loadConfig(process.env);
        // SMTP_URL is read here rather than in the shared schema: the schema refuses
        // development shortcuts, and the transport refuses itself without a URL.
        return createEmailSender(config.EMAIL_PROVIDER, config.NODE_ENV, process.env.SMTP_URL);
      },
    },
    {
      provide: TURNSTILE_VERIFIER,
      useFactory: () => {
        const config = loadConfig(process.env);
        return createTurnstileVerifier(config.NODE_ENV, config.TURNSTILE_SECRET_KEY);
      },
    },
    RateLimiter,
    AuthService,
    AccountService,
    AdminUsersService,
    SettingsService,
    AuditService,
    DashboardService,
    CatalogRevalidationService,
    CatalogService,
    // Deny-by-default everywhere: the guard refuses any route without a declaration.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
