import { Request, Response, Router } from 'express';

import { evolutionAdapter } from '../adapters/evolution.adapter';
import { platformAuthMiddleware } from '../middleware/platform-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { PlatformTenant } from '../types/platform-tenant';

const router: Router = Router();
const auditService = new AuditService();

/**
 * List contacts for the authenticated tenant.
 * GET /accounts/:accountId/contacts
 * accountId in URL must match the authenticated tenant's publicId.
 */
router.get(
  '/:accountId/contacts',
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

      const contacts = await platformRepository.platformContact.findMany({
        where: { accountId: platformTenant.accountId },
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
 * POST /accounts/:accountId/instances/:instId/contacts/sync
 * instId is the public ID (inst_xxx).
 */
router.post(
  '/:accountId/instances/:instId/contacts/sync',
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

      // Fetch contacts from the Evolution engine
      const canonicalContacts = await evolutionAdapter.fetchContacts(instance.id);

      let syncedCount = 0;
      for (const contact of canonicalContacts) {
        await platformRepository.platformContact.upsert({
          where: {
            accountId_phoneNumber: {
              accountId: platformTenant.accountId,
              phoneNumber: contact.phoneNumber,
            },
          },
          create: {
            publicId: contact.id,
            accountId: platformTenant.accountId,
            appId: platformTenant.defaultApp.id,
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
        platformTenant.accountId,
        'CONTACTS_SYNC',
        { type: 'contact', id: '' },
        { instanceId: req.params.instId, count: syncedCount },
      );

      res.json({ success: true, syncedCount });
    } catch {
      res.status(500).json({ error: 'SYNC_ERROR' });
    }
  },
);

export { router as contactRoutes };
