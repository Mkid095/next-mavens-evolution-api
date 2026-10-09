import { waMonitor } from '@api/server.module';
import { Request, Response, Router } from 'express';

import { evolutionAdapter } from '../adapters/evolution.adapter';
import { hybridAuth } from '../middleware/hybrid-auth.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { InstanceService } from '../services/instance.service';
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
 * List instances for the authenticated tenant.
 * GET /accounts/:accountId/instances
 * accountId in URL must match the authenticated tenant's publicId.
 */
router.get(
  '/:accountId/instances',
  hybridAuth(getSessionService()),
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

      const instances = await platformRepository.platformInstance.findMany({
        where: { accountId: platformTenant.accountId },
        select: {
          id: true,
          publicId: true,
          name: true,
          status: true,
          phoneNumber: true,
          capabilities: true,
          lastConnectedAt: true,
          createdAt: true,
        },
      });

      res.json(instances);
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Create instance for the authenticated tenant.
 * POST /accounts/:accountId/instances
 * accountId in URL must match the authenticated tenant's publicId.
 */
router.post(
  '/:accountId/instances',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  idempotencyMiddleware.check,
  async (req: Request, res: Response) => {
    try {
      const req2 = req as Request & {
        platformKey?: { accountId: string; apiKeyId: string; scopes: string[] };
        platformTenant?: PlatformTenant;
        idempotencyKey?: string;
      };
      const platformTenant = req2.platformTenant;
      if (!platformTenant) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
      if (platformTenant.publicId !== req.params.accountId) {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }

      const { name } = req.body;
      if (!name) {
        res.status(400).json({ error: 'MISSING_FIELDS', message: 'name is required' });
        return;
      }

      // Idempotent create: check for existing instance by (accountId, name) first.
      // This is the authoritative idempotency anchor for instance creation since
      // the instance name is unique per account and the client-supplied idempotency
      // key is scoped to (accountId, apiKeyId, idempotencyKey) in the middleware.
      const existing = await platformRepository.platformInstance.findFirst({
        where: { accountId: platformTenant.accountId, name },
      });

      if (existing) {
        const responseBody = {
          id: existing.publicId,
          name: existing.name,
          status: existing.status,
          createdAt: existing.createdAt,
        };
        await idempotencyMiddleware.complete(req, res, responseBody, existing.publicId);
        res.status(200).json(responseBody);
        return;
      }

      // Use InstanceService.create which BOTH creates the canonical
      // PlatformInstance row AND pre-allocates the underlying Evolution
      // Instance row. Without this, the connect flow would have to find-
      // or-create the Evolution row against a private member variable
      // that doesn't exist on waMonitor (silent failure → no QR).
      const instanceService = new InstanceService();
      const instance = await instanceService.create(platformTenant.accountId, name);

      await auditService.record(platformTenant.accountId, 'INSTANCE_CREATE', {
        type: 'instance',
        id: instance.publicId,
      });

      const responseBody = {
        id: instance.publicId,
        name: instance.name,
        status: instance.status,
        createdAt: instance.createdAt,
      };

      await idempotencyMiddleware.complete(req, res, responseBody, instance.publicId);

      res.status(201).json(responseBody);
    } catch {
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

/**
 * Get instance by publicId.
 * GET /accounts/:accountId/instances/:instId
 * accountId in URL must match the authenticated tenant's publicId.
 * instId is the public ID (inst_xxx).
 */
router.get(
  '/:accountId/instances/:instId',
  hybridAuth(getSessionService()),
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
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      // Try to attach the live QR code from the engine (in-memory state).
      // Three sources, in order of freshness:
      //  1. evolutionAdapter.getCachedQr — most recent QR captured by the
      //     service's QR event listener (populated in real-time)
      //  2. waMonitor.waInstances[name].qrCode — direct read of the
      //     Baileys service's current QR (in-memory, may be empty)
      //  3. Redis subscriber event (handled by SSE)
      let qrCode: { base64: string | null; pairingCode: string | null } | null = null;
      try {
        const cached = evolutionAdapter.getCachedQr(instance.name);
        if (cached?.base64) {
          qrCode = { base64: cached.base64, pairingCode: cached.pairingCode ?? null };
        } else {
          const engineInstance = waMonitor.waInstances[instance.name];
          if (engineInstance) {
            const liveQr = (engineInstance as any).qrCode;
            if (liveQr?.base64) {
              qrCode = {
                base64: liveQr.base64 ?? null,
                pairingCode: liveQr.pairingCode ?? null,
              };
            }
          }
        }
      } catch {
        /* engine not initialized yet — that's fine, no QR to return */
      }

      res.json({
        id: instance.publicId,
        internalId: instance.id, // engine CUID, used by /messages/send
        publicId: instance.publicId,
        name: instance.name,
        status: instance.status,
        phoneNumber: instance.phoneNumber,
        capabilities: instance.capabilities,
        lastConnectedAt: instance.lastConnectedAt,
        createdAt: instance.createdAt,
        ...(qrCode ? { qrCode } : {}),
      });
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Connect instance.
 * POST /accounts/:accountId/instances/:instId/connect
 * instId is the public ID (inst_xxx).
 */
router.post(
  '/:accountId/instances/:instId/connect',
  hybridAuth(getSessionService()),
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
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      await evolutionAdapter.connectInstance(instance.id);

      await auditService.record(platformTenant.accountId, 'INSTANCE_CONNECT', {
        type: 'instance',
        id: instance.publicId,
      });

      res.json({ success: true, status: 'CONNECTING' });
    } catch {
      res.status(500).json({ error: 'CONNECT_ERROR' });
    }
  },
);

/**
 * Disconnect instance.
 * POST /accounts/:accountId/instances/:instId/disconnect
 * instId is the public ID (inst_xxx).
 */
router.post(
  '/:accountId/instances/:instId/disconnect',
  hybridAuth(getSessionService()),
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
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      await evolutionAdapter.disconnectInstance(instance.id);

      await auditService.record(platformTenant.accountId, 'INSTANCE_DISCONNECT', {
        type: 'instance',
        id: instance.publicId,
      });

      res.json({ success: true, status: 'DISCONNECTED' });
    } catch {
      res.status(500).json({ error: 'DISCONNECT_ERROR' });
    }
  },
);

/**
 * Restart instance.
 * POST /accounts/:accountId/instances/:instId/restart
 * instId is the public ID (inst_xxx).
 */
router.post(
  '/:accountId/instances/:instId/restart',
  hybridAuth(getSessionService()),
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
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      await evolutionAdapter.restartInstance(instance.id);

      await auditService.record(platformTenant.accountId, 'INSTANCE_RESTART', {
        type: 'instance',
        id: instance.publicId,
      });

      res.json({ success: true, status: 'RESTARTING' });
    } catch {
      res.status(500).json({ error: 'RESTART_ERROR' });
    }
  },
);

/**
 * Get canonical instance state.
 * GET /accounts/:accountId/instances/:instId/state
 * instId is the public ID (inst_xxx).
 * Returns CONNECTED/CONNECTING/CREATED/DISCONNECTED/SUSPENDED — never JIDs or engine refs.
 */
router.get(
  '/:accountId/instances/:instId/state',
  hybridAuth(getSessionService()),
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
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      const state = await evolutionAdapter.getInstanceState(instance.id);

      res.json({
        id: state.publicId,
        status: state.status,
        phoneNumber: state.phoneNumber,
        capabilities: state.capabilities,
        connectedAt: state.connectedAt,
      });
    } catch {
      res.status(500).json({ error: 'STATE_ERROR' });
    }
  },
);

/**
 * Delete instance.
 * DELETE /accounts/:accountId/instances/:instId
 * instId is the public ID (inst_xxx).
 */
router.delete(
  '/:accountId/instances/:instId',
  hybridAuth(getSessionService()),
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
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      // Disconnect first if connected
      try {
        await evolutionAdapter.disconnectInstance(instance.id);
      } catch {
        // Ignore disconnect errors when deleting
      }

      await platformRepository.platformInstance.delete({
        where: { id: instance.id },
      });

      await auditService.record(platformTenant.accountId, 'INSTANCE_DELETE', {
        type: 'instance',
        id: req.params.instId,
      });

      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'DELETE_ERROR' });
    }
  },
);

/**
 * Bind API key to instance.
 * POST /accounts/:accountId/api-keys/:keyId/instances/:instId/bind
 * keyId and instId are PUBLIC IDs (key_xxx and inst_xxx).
 */
router.post(
  '/:accountId/api-keys/:keyId/instances/:instId/bind',
  hybridAuth(getSessionService()),
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

      // Look up the actual API key database ID from the public ID
      const apiKey = await platformRepository.platformApiKey.findFirst({
        where: {
          publicId: req.params.keyId,
          accountId: platformTenant.accountId,
        },
      });

      if (!apiKey) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'API key not found' });
        return;
      }

      // Look up the actual instance database ID from the public ID
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

      // Create the binding record
      await platformRepository.platformApiKeyInstance.create({
        data: {
          apiKeyId: apiKey.id,
          instanceId: instance.id,
        },
      });

      await auditService.record(
        platformTenant.accountId,
        'API_KEY_BIND',
        { type: 'api-key-instance', id: '' },
        { apiKeyId: req.params.keyId, instanceId: req.params.instId },
      );

      res.status(201).json({ success: true });
    } catch (error) {
      // Handle unique constraint violation (already bound)
      if ((error as any).code === 'P2002') {
        res.status(409).json({ error: 'ALREADY_BOUND' });
        return;
      }
      res.status(500).json({ error: 'BIND_ERROR' });
    }
  },
);

export { router as instanceRoutes };
