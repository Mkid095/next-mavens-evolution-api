import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { hybridAuth } from '../middleware/hybrid-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { platformRateLimitMiddleware } from '../middleware/platform-rate-limit.middleware';
import { entitlementMiddleware } from '../middleware/entitlement.middleware';
import { getSessionService } from './auth.routes';

interface PlatformTenant {
  accountId: string;
  publicId: string;
  status: string;
  plan: { planId: string; name: string; monthlyMessageLimit: number | null };
}

const router: Router = Router();
const auditService = new AuditService();

/**
 * Send a message via the PUBLIC instance id (inst_xxx).
 * POST /api/v1/messages/send
 *
 * Body: { instancePublicId: string, number: string, text: string, type?: string }
 *
 * This is the canonical public-facing route — the dashboard uses this one.
 * Resolves the publicId to the PlatformInstance (which carries the tenant
 * ownership), then enqueues a durable PlatformMessageCommand.
 *
 * Auth: hybridAuth accepts EITHER X-API-Key OR sessionId cookie, so both
 * programmatic API consumers and the dashboard (cookie session) work.
 */
router.post(
  '/send',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  idempotencyMiddleware.check,
  platformRateLimitMiddleware.apply,
  entitlementMiddleware.checkMessageLimit,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    const { instancePublicId, number, text, type } = req.body ?? {};
    if (!instancePublicId || !number || !text) {
      res.status(400).json({ error: 'MISSING_FIELDS', message: 'instancePublicId, number, and text are required' });
      return;
    }

    const platformInstance = await platformRepository.platformInstance.findFirst({
      where: { publicId: instancePublicId, accountId: platformTenant.accountId },
    });

    if (!platformInstance) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Instance not found' });
      return;
    }

    // Existence of the engine Instance is implicit because
    // InstanceService.create() pre-allocates it. We still check for
    // defensive logging.
    const engineInstance = await platformRepository.instance.findFirst({
      where: { name: platformInstance.name },
    });

    if (!engineInstance) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Engine instance not provisioned' });
      return;
    }

    const messageId = `msg_${crypto.randomBytes(8).toString('hex')}`;
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    try {
      await platformRepository.platformMessageCommand.create({
        data: {
          idempotencyKey: idempotencyKey ?? `inline_${messageId}`,
          accountId: platformTenant.accountId,
          instanceId: platformInstance.id,
          apiKeyId: (req as Request & { platformKey?: { apiKeyId: string } }).platformKey?.apiKeyId ?? '',
          messageId,
          type: type ?? 'text',
          recipient: number,
          content: { text },
          status: 'queued',
          attempts: 0,
        },
      });

      await auditService.record(platformTenant.accountId, 'MESSAGE_SEND', {
        type: 'message',
        id: messageId,
      });

      idempotencyMiddleware.complete(req, res, { messageId }, messageId);

      res.status(202).json({ messageId });
    } catch (error) {
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

export { router as messagePublicRoutes };
