import { Logger } from '@config/logger.config';
import crypto from 'crypto';
import { Request, Response, Router } from 'express';

import { evolutionAdapter } from '../adapters/evolution.adapter';
import { entitlementMiddleware } from '../middleware/entitlement.middleware';
import { hybridAuth } from '../middleware/hybrid-auth.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { platformRateLimitMiddleware } from '../middleware/platform-rate-limit.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { describeError } from '../services/describe-error';
import { MESSAGE_STATES, messageStatusService } from '../services/message-status.service';
import { buildOutgoing } from '../services/outgoing-message';
import { PlatformTenant } from '../types/platform-tenant';
import { getSessionService } from './auth.routes';
import { keyIsScopedElsewhere } from './project-scope';

const router: Router = Router();
const auditService = new AuditService();
const logger = new Logger('MessageRoutes');

/** How many numbers one on-WhatsApp check may carry. */
const MAX_NUMBERS_PER_CHECK = 500;

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

    const { instancePublicId, number } = req.body ?? {};
    if (!instancePublicId || !number) {
      res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'instancePublicId and number are required',
      });
      return;
    }

    /*
     * What will actually be transmitted. A type the platform accepted
     * but never sent — location, poll, template, interactive, button —
     * is rejected here rather than queued and dropped on the floor.
     */
    const draft = buildOutgoing(req.body ?? {});
    if (draft.ok === false) {
      res.status(400).json({ error: draft.error, message: draft.message });
      return;
    }

    const platformInstance = await platformRepository.platformInstance.findFirst({
      where: { publicId: instancePublicId, accountId: platformTenant.accountId },
    });

    if (!platformInstance) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Instance not found' });
      return;
    }

    // A project-scoped key may only send through instances of its own
    // project. An account-level personal access token may use any
    // instance of the account.
    if (keyIsScopedElsewhere(req, platformInstance.projectId)) {
      res.status(403).json({
        error: 'PROJECT_ACCESS_DENIED',
        message: 'This API key is scoped to a different project',
      });
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
          projectId: platformInstance.projectId,
          instanceId: platformInstance.id,
          apiKeyId: (req as Request & { platformKey?: { apiKeyId: string } }).platformKey?.apiKeyId ?? '',
          messageId,
          type: draft.message.type,
          recipient: number,
          content: draft.message.content as object,
          status: 'queued',
          attempts: 0,
        },
      });

      await auditService.record(
        platformTenant.accountId,
        'MESSAGE_SEND',
        {
          type: 'message',
          id: messageId,
        },
        { instancePublicId: platformInstance.publicId },
        { projectId: platformInstance.projectId },
      );

      idempotencyMiddleware.complete(req, res, { messageId }, messageId);

      res.status(202).json({ messageId });
    } catch {
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

/**
 * How a batch of messages is doing.
 * GET /api/v1/messages/summary
 *
 * The counts a broadcast needs: how many went out, how many are still
 * waiting, how many reached the recipient rather than merely leaving the
 * platform, and what the failures were.
 *
 * Query:
 *   instancePublicId  only messages sent through this instance
 *   since             ISO timestamp — anything created at or after it
 */
router.get(
  '/summary',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    let since: Date | undefined;
    if (typeof req.query.since === 'string' && req.query.since) {
      since = new Date(req.query.since);
      if (Number.isNaN(since.getTime())) {
        res.status(400).json({ error: 'INVALID_SINCE', message: 'since must be an ISO timestamp' });
        return;
      }
    }

    try {
      const summary = await messageStatusService.summary(platformTenant.accountId, {
        instancePublicId: typeof req.query.instancePublicId === 'string' ? req.query.instancePublicId : undefined,
        since,
      });
      res.json(summary);
    } catch (error) {
      logger.error(`Message summary failed: ${describeError(error)}`);
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Which of these numbers are on WhatsApp.
 * POST /api/v1/messages/check-numbers
 * Body: { instancePublicId, numbers: [...] }
 *
 * WhatsApp accepts a message to a number that has no account and never
 * delivers it, so a send that says "sent" is not proof of delivery. A
 * broadcast asks first: this is where the numbers that are not on
 * WhatsApp come from.
 */
router.post(
  '/check-numbers',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    const { instancePublicId, numbers } = req.body ?? {};
    if (!instancePublicId || !Array.isArray(numbers) || numbers.length === 0) {
      res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'instancePublicId and a non-empty numbers array are required',
      });
      return;
    }
    if (numbers.length > MAX_NUMBERS_PER_CHECK) {
      res.status(400).json({
        error: 'TOO_MANY_NUMBERS',
        message: `At most ${MAX_NUMBERS_PER_CHECK} numbers can be checked at once`,
      });
      return;
    }

    const platformInstance = await platformRepository.platformInstance.findFirst({
      where: { publicId: instancePublicId, accountId: platformTenant.accountId },
    });
    if (!platformInstance) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Instance not found' });
      return;
    }

    if (keyIsScopedElsewhere(req, platformInstance.projectId)) {
      res.status(403).json({
        error: 'PROJECT_ACCESS_DENIED',
        message: 'This API key is scoped to a different project',
      });
      return;
    }

    try {
      const checked = await evolutionAdapter.checkNumbersOnWhatsapp(
        platformInstance.id,
        numbers.map((n) => String(n)),
      );
      res.json({
        total: checked.length,
        onWhatsapp: checked.filter((c) => c.onWhatsapp).length,
        notOnWhatsapp: checked.filter((c) => !c.onWhatsapp).length,
        results: checked,
      });
    } catch (error) {
      logger.error(`Number check failed: ${describeError(error)}`);
      res.status(500).json({
        error: 'CHECK_ERROR',
        message: describeError(error),
      });
    }
  },
);

/**
 * The state of one message.
 * GET /api/v1/messages/:messageId
 *
 * The `messageId` is the one the send route returned. The state is the
 * one the outbox wrote: queued, processing, sent, failed or skipped.
 *
 * A shop owner opening the app wants to know whether a broadcast has
 * gone out without waiting for an event to arrive — this is that read.
 */
router.get(
  '/:messageId',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    try {
      const message = await messageStatusService.get(platformTenant.accountId, req.params.messageId);
      if (!message) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Message not found' });
        return;
      }
      res.json(message);
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Recent messages, newest first.
 * GET /api/v1/messages
 *
 * Query:
 *   instancePublicId  only messages sent through this instance
 *   state             queued | processing | sent | failed | skipped
 *   since             ISO timestamp — anything created at or after it
 *   limit             page size (default 50, max 200)
 *   cursor            the `nextCursor` of the previous page
 */
router.get(
  '/',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!platformTenant) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    const state = typeof req.query.state === 'string' ? req.query.state.toLowerCase() : undefined;
    if (state && !MESSAGE_STATES.includes(state as never)) {
      res.status(400).json({
        error: 'INVALID_STATE',
        message: `Unknown state "${state}"`,
        states: MESSAGE_STATES,
      });
      return;
    }

    let since: Date | undefined;
    if (typeof req.query.since === 'string' && req.query.since) {
      since = new Date(req.query.since);
      if (Number.isNaN(since.getTime())) {
        res.status(400).json({ error: 'INVALID_SINCE', message: 'since must be an ISO timestamp' });
        return;
      }
    }

    const rawLimit = Number(req.query.limit);

    try {
      const page = await messageStatusService.list(platformTenant.accountId, {
        instancePublicId: typeof req.query.instancePublicId === 'string' ? req.query.instancePublicId : undefined,
        state: state as never,
        since,
        limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
        cursor: typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined,
      });
      res.json(page);
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

export { router as messagePublicRoutes };
