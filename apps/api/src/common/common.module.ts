import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ENV, loadEnv } from '../config/env';
import { AccessGuard } from './auth/access.guard';
import { JwtService } from './auth/jwt.service';
import { SecretBox } from './crypto/secret-box';
import { DbService } from './db/db.service';
import { EntitlementsService } from './entitlements/entitlements.service';
import { EventDispatcher } from './events/dispatcher.service';
import { ApiExceptionFilter } from './errors/exception.filter';
import { RateLimiter } from './http/rate-limiter';
import { AuditService } from './platform/audit.service';
import { IdempotencyService } from './platform/idempotency.service';
import { OutboxService } from './platform/outbox.service';
import { WebhookInboxService } from './platform/webhook-inbox.service';
import { StorageService } from './storage/storage.service';

const shared = [EventDispatcher, DbService, JwtService, EntitlementsService, RateLimiter, AuditService, OutboxService, IdempotencyService, SecretBox, StorageService, WebhookInboxService];

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    ...shared,
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
  exports: [ENV, ...shared],
})
export class CommonModule {}
