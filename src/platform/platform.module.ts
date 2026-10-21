import { antiBanService } from '@api/services/anti-ban.instance';
import { Logger } from '@config/logger.config';

import { evolutionAdapter } from './adapters/evolution.adapter';
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
// The outbox worker sends queued messages one at a time, paced per instance,
// and consults the shared anti-ban guard before every send.
const outboxWorkerService = new OutboxWorkerService({ antiBan: antiBanService });
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

/*
 * Keep the platform's view of the instances in step with the engine's.
 *
 * The engine owns the truth about whether a WhatsApp device is
 * connected. The platform row is a copy of that truth, and a copy that
 * is only refreshed when somebody opens the right page is a copy that
 * lies. A short sweep keeps it honest, and it is what makes a device
 * paired while the dashboard was closed show up as connected.
 */
const INSTANCE_SYNC_INTERVAL_MS = 15_000;
void (async () => {
  // One sweep at boot, then on the interval.
  const sweep = async () => {
    try {
      await evolutionAdapter.syncAllInstanceStatuses();
    } catch (error) {
      logger.warn(`Instance status sync failed: ${error}`);
    }
  };
  await sweep();
  setInterval(() => void sweep(), INSTANCE_SYNC_INTERVAL_MS);
})();

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
