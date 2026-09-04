import { Logger } from '@config/logger.config';
import { platformRepository } from './repository/platform.repository';
import { platformRouter } from './platform.router';
import { PlatformAuthService } from './services/platform-auth.service';
import { TenantService } from './services/tenant.service';
import { SubscriptionService } from './services/subscription.service';
import { RateLimitService } from './services/rate-limit.service';
import { EntitlementService } from './services/entitlement.service';
import { IdempotencyService } from './services/idempotency.service';
import { OutboxWorkerService } from './services/outbox-worker.service';
import { AuditService } from './services/audit.service';
import { UsageService } from './services/usage.service';
import { WebhookService } from './services/webhook.service';

const logger = new Logger('PLATFORM MODULE');

// Initialize services
const platformAuthService = new PlatformAuthService();
const tenantService = new TenantService();
const subscriptionService = new SubscriptionService();
const rateLimitService = new RateLimitService();
const entitlementService = new EntitlementService();
const idempotencyService = new IdempotencyService();
const outboxWorkerService = new OutboxWorkerService();
const auditService = new AuditService();
const usageService = new UsageService();
const webhookService = new WebhookService();

// Start outbox worker
outboxWorkerService.start();

logger.info('Platform module initialized');

export {
  platformRepository,
  platformRouter,
  PlatformAuthService,
  TenantService,
  SubscriptionService,
  RateLimitService,
  EntitlementService,
  IdempotencyService,
  OutboxWorkerService,
  AuditService,
  UsageService,
  WebhookService,
  platformAuthService,
  tenantService,
  subscriptionService,
  rateLimitService,
  entitlementService,
  idempotencyService,
  auditService,
  usageService,
  webhookService,
};
