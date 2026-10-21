import { Logger } from '@config/logger.config';
import { Request, Response, Router } from 'express';
import { createClient, RedisClientType } from 'redis';

import { hybridAuth } from '../middleware/hybrid-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { PlatformTenant } from '../types/platform-tenant';
import { getSessionService } from './auth.routes';

const router: Router = Router();
const logger = new Logger('ActivityRoute');

/**
 * GET /api/v1/platform/activity/history
 *
 * Recent audit events for the authenticated account, newest first.
 * Optional `since` (createdAt ISO) cursor. Optional `limit` (default
 * 50, max 200). Optional `projectId` filter for project-scoped views.
 */
router.get(
  '/history',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const projectPublicId = typeof req.query.projectPublicId === 'string' ? req.query.projectPublicId : null;

    let projectId: string | null = null;
    if (projectPublicId) {
      const project = await platformRepository.platformProject.findFirst({
        where: { publicId: projectPublicId, accountId: tenant.accountId },
        select: { id: true },
      });
      if (!project) {
        res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        return;
      }
      projectId = project.id;
    }

    const where: any = { accountId: tenant.accountId };
    if (since && !isNaN(since.getTime())) {
      where.createdAt = { gt: since };
    }
    if (projectId) {
      where.projectId = projectId;
    }

    const rows = await platformRepository.platformAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json({
      events: rows.map((r) => {
        const m = (r.metadata as any) ?? {};
        return {
          id: r.id,
          action: r.action,
          category: m.category,
          resourceType: r.resource ?? undefined,
          resourceId: r.resourceId ?? undefined,
          projectId: r.projectId ?? m.projectId,
          instancePublicId: m.instancePublicId,
          message: `${r.action.toLowerCase().replace(/_/g, ' ')}: ${r.resourceId ?? ''}`,
          success: r.success,
          metadata: r.metadata ?? undefined,
          ts: r.createdAt.getTime(),
        };
      }),
    });
  },
);

/**
 * GET /api/v1/platform/activity/stream
 *
 * Server-Sent Events stream of audit events for the authenticated
 * account. The dashboard subscribes to this for the global
 * topbar activity feed.
 *
 * SSE format:
 *   event: activity
 *   data: { id, action, category, resourceType, resourceId, projectId, instancePublicId, message, ts }
 *
 * Heartbeat every 25 s. Falls back to `: redis-unavailable` comment
 * if the broker is unreachable. Clean disconnect on `req.close`.
 */
router.get(
  '/stream',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`: connected to activity stream\n\n`);
    res.flush();

    const keepalive = setInterval(() => {
      res.write(`: heartbeat\n\n`);
      res.flush();
    }, 25000);

    let subscriber: RedisClientType | null = null;
    let cancelled = false;
    try {
      const url = process.env.CACHE_REDIS_URI || 'redis://platform-redis:6379/6';
      subscriber = createClient({ url });
      subscriber.on('error', (err) => {
        logger.warn(`[activity SSE] subscriber error: ${err}`);
        res.write(`: redis-error\n\n`);
        res.flush();
      });
      await subscriber.connect();
      const channel = `fidscript:whatsapp:activity:${tenant.accountId}`;
      await subscriber.subscribe(channel, (message) => {
        if (cancelled) return;
        try {
          JSON.parse(message);
          res.write(`event: activity\ndata: ${message}\n\n`);
          res.flush();
        } catch {
          /* skip malformed message */
        }
      });
    } catch (err) {
      logger.warn(`[activity SSE] could not subscribe to Redis: ${err}`);
      res.write(`: redis-unavailable\n\n`);
      res.flush();
    }

    req.on('close', async () => {
      cancelled = true;
      clearInterval(keepalive);
      if (subscriber) {
        try {
          await subscriber.unsubscribe();
          await subscriber.disconnect();
        } catch {
          /* ignore cleanup errors */
        }
      }
    });
  },
);

export { router as activityRoutes };
