import crypto from 'crypto';
import { Request, Response, Router } from 'express';

import { evolutionAdapter } from '../adapters/evolution.adapter';
import { hybridAuth } from '../middleware/hybrid-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { getSessionService } from './auth.routes';
import { requireProjectContext, requireProjectInstance } from './project-scope';

const router: Router = Router();
const auditService = new AuditService();

/**
 * List the groups of a project.
 * GET /accounts/:accountId/projects/:projectPublicId/groups
 */
router.get(
  '/:accountId/projects/:projectPublicId/groups',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const groups = await platformRepository.platformGroup.findMany({
        where: { projectId: context.project.id },
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
 * POST /accounts/:accountId/projects/:projectPublicId/instances/:instId/groups/sync
 * instId is the public ID (inst_xxx).
 */
router.post(
  '/:accountId/projects/:projectPublicId/instances/:instId/groups/sync',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const instance = await requireProjectInstance(req, res, context.project.id);
      if (!instance) return;

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
              accountId: context.tenant.accountId,
              projectId: context.project.id,
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
        context.tenant.accountId,
        'GROUPS_SYNC',
        { type: 'group', id: '' },
        { instanceId: req.params.instId, count: syncedCount },
        { projectId: context.project.id },
      );

      res.json({ success: true, syncedCount });
    } catch {
      res.status(500).json({ error: 'SYNC_ERROR' });
    }
  },
);

export { router as groupRoutes };
