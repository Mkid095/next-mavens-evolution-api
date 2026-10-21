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
 * List the contacts of a project.
 * GET /accounts/:accountId/projects/:projectPublicId/contacts
 */
router.get(
  '/:accountId/projects/:projectPublicId/contacts',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const contacts = await platformRepository.platformContact.findMany({
        where: { projectId: context.project.id },
        select: {
          publicId: true,
          phoneNumber: true,
          jid: true,
          lid: true,
          displayName: true,
          profilePhotoUrl: true,
          lastSeenAt: true,
          createdAt: true,
        },
      });

      res.json(contacts);
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Sync contacts from Evolution engine.
 * POST /accounts/:accountId/projects/:projectPublicId/instances/:instId/contacts/sync
 * instId is the public ID (inst_xxx).
 */
router.post(
  '/:accountId/projects/:projectPublicId/instances/:instId/contacts/sync',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const instance = await requireProjectInstance(req, res, context.project.id);
      if (!instance) return;

      // Fetch contacts from the Evolution engine
      const canonicalContacts = await evolutionAdapter.fetchContacts(instance.id);

      let syncedCount = 0;
      for (const contact of canonicalContacts) {
        await platformRepository.platformContact.upsert({
          where: {
            accountId_phoneNumber: {
              accountId: context.tenant.accountId,
              phoneNumber: contact.phoneNumber,
            },
          },
          create: {
            publicId: contact.id,
            accountId: context.tenant.accountId,
            projectId: context.project.id,
            instanceId: instance.id,
            phoneNumber: contact.phoneNumber,
            jid: contact.jid,
            lid: contact.lid,
            displayName: contact.displayName,
            profilePhotoUrl: contact.profilePhotoUrl,
          },
          update: {
            jid: contact.jid ?? undefined,
            lid: contact.lid ?? undefined,
            displayName: contact.displayName ?? undefined,
            profilePhotoUrl: contact.profilePhotoUrl ?? undefined,
          },
        });
        syncedCount++;
      }

      await auditService.record(
        context.tenant.accountId,
        'CONTACTS_SYNC',
        { type: 'contact', id: '' },
        { instanceId: req.params.instId, count: syncedCount },
        { projectId: context.project.id },
      );

      res.json({ success: true, syncedCount });
    } catch {
      res.status(500).json({ error: 'SYNC_ERROR' });
    }
  },
);

export { router as contactRoutes };
