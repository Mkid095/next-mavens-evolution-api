import { Logger } from '@config/logger.config';

import { platformRouter } from './platform.router';
import { platformRepository } from './repository/platform.repository';
import { setSessionService } from './routes/auth.routes';
import { AuditService } from './services/audit.service';
import { EntitlementService } from './services/entitlement.service';
import { IdempotencyService } from './services/idempotency.service';
import { OutboxWorkerService } from './services/outbox-worker.service';
import { PlatformAuthService } from './services/platform-auth.service';
import { RateLimitService } from './services/rate-limit.service';
import { SessionService } from './services/session.service';
import { settingsService } from './services/settings.service';
import { SubscriptionService } from './services/subscription.service';
import { TenantService } from './services/tenant.service';
import { UsageService } from './services/usage.service';
import { WebhookService } from './services/webhook.service';
import { LifecycleEventWorker } from './workers/lifecycle-event.worker';
import { WebhookDeliveryWorker } from './workers/webhook-delivery.worker';

const logger = new Logger('PLATFORM MODULE');

// Initialize services
const platformAuthService = new PlatformAuthService();
const tenantService = new TenantService();
const subscriptionService = new SubscriptionService();
const rateLimitService = new RateLimitService();
const entitlementService = new EntitlementService();
const idempotencyService = new IdempotencyService();
const outboxWorkerService = new OutboxWorkerService();
const lifecycleEventWorker = new LifecycleEventWorker();
const webhookDeliveryWorker = new WebhookDeliveryWorker();
const auditService = new AuditService();
const usageService = new UsageService();
const webhookService = new WebhookService();
const sessionService = new SessionService();

// Register session service with auth routes so middleware can use it
setSessionService(sessionService);

// Start outbox worker
outboxWorkerService.start();
lifecycleEventWorker.start();
webhookDeliveryWorker.start();

// Seed encrypted settings (company gate password) on a fresh database.
// Fire-and-forget: a failure here must not stop the API from booting —
// the gate simply stays locked, which is the safe failure mode.
void settingsService.seedDefaults();

logger.info('Platform module initialized');

export {
  AuditService,
  auditService,
  EntitlementService,
  entitlementService,
  IdempotencyService,
  idempotencyService,
  LifecycleEventWorker,
  OutboxWorkerService,
  PlatformAuthService,
  platformAuthService,
  platformRepository,
  platformRouter,
  RateLimitService,
  rateLimitService,
  SubscriptionService,
  subscriptionService,
  TenantService,
  tenantService,
  UsageService,
  usageService,
  WebhookDeliveryWorker,
  WebhookService,
  webhookService,
};
