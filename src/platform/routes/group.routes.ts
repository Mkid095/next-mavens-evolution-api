import crypto from 'crypto';
import { Request, Response, Router } from 'express';

import { evolutionAdapter } from '../adapters/evolution.adapter';
import { platformAuthMiddleware } from '../middleware/platform-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';

interface PlatformTenant {
  accountId: string;
  publicId: string;
  status: string;
  plan: { planId: string; name: string; monthlyMessageLimit: number | null };
}

const router: Router = Router();
const auditService = new AuditService();

/**
 * List groups for the authenticated tenant.
 * GET /accounts/:accountId/groups
 * accountId in URL must match the authenticated tenant's publicId.
 */
router.get(
  '/:accountId/groups',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
      if (platformTenant.publicId !== req.params.accountId) {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }

      const groups = await platformRepository.platformGroup.findMany({
        where: { accountId: platformTenant.accountId },
        select: {
          publicId: true,
          name: true,
          participantCount: true,
          createdAt: true,
          // engineRefs (groupJid) are internal — NOT exposed in public API
        },
      });

      res.json(groups);
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Sync groups from Evolution engine.
 * POST /accounts/:accountId/instances/:instId/groups/sync
 * instId is the public ID (inst_xxx).
 */
router.post(
  '/:accountId/instances/:instId/groups/sync',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
      if (platformTenant.publicId !== req.params.accountId) {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }

      const instance = await platformRepository.platformInstance.findFirst({
        where: {
          publicId: req.params.instId,
          accountId: platformTenant.accountId,
        },
      });

      if (!instance) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Instance not found' });
        return;
      }

      // Fetch groups from the Evolution engine (uses internal method with engineJid for upsert matching)
      const engineGroups = await evolutionAdapter.fetchGroupsForSync(instance.id);

      let syncedCount = 0;
      for (const group of engineGroups) {
        // Find existing group by engine JID reference
        const existingRef = await platformRepository.platformGroupEngineRef.findFirst({
          where: {
            instanceId: instance.id,
            groupJid: group.engineJid,
          },
          include: { group: true },
        });

        if (existingRef) {
          // Update existing group
          await platformRepository.platformGroup.update({
            where: { id: existingRef.groupId },
            data: {
              name: group.name,
              participantCount: group.participantCount,
            },
          });
        } else {
          // Create new group with engine ref
          const publicId = `grp_${crypto.randomBytes(8).toString('hex')}`;
          await platformRepository.platformGroup.create({
            data: {
              publicId,
              accountId: platformTenant.accountId,
              instanceId: instance.id,
              name: group.name,
              participantCount: group.participantCount,
              engineRefs: {
                create: {
                  instanceId: instance.id,
                  provider: 'evolution',
                  groupJid: group.engineJid,
                },
              },
            },
          });
        }
        syncedCount++;
      }

      await auditService.record(
        platformTenant.accountId,
        'GROUPS_SYNC',
        { type: 'group', id: '' },
        { instanceId: req.params.instId, count: syncedCount },
      );

      res.json({ success: true, syncedCount });
    } catch {
      res.status(500).json({ error: 'SYNC_ERROR' });
    }
  },
);

export { router as groupRoutes };
