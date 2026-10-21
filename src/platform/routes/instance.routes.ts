import { waMonitor } from '@api/server.module';
import { Request, Response, Router } from 'express';

import { evolutionAdapter } from '../adapters/evolution.adapter';
import { hybridAuth } from '../middleware/hybrid-auth.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { scopeEnforceMiddleware } from '../middleware/scope-enforce.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { AuditService } from '../services/audit.service';
import { InstanceService } from '../services/instance.service';
import { getSessionService } from './auth.routes';
import { requireProjectContext, requireProjectInstance } from './project-scope';

const router: Router = Router();
const auditService = new AuditService();

/**
 * Canonical Instance DTO used by LIST, CREATE, and GET responses.
 * Keeps the publicId stable across all endpoints so the dashboard can
 * always navigate to /dashboard/instances/{id} without a name swap.
 */
function toInstanceDTO(row: {
  id: string;
  publicId: string;
  name: string;
  status: string;
  phoneNumber: string | null;
  capabilities: unknown;
  lastConnectedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.publicId, // external-facing id is the publicId
    internalId: row.id, // engine CUID, used by internal routes
    publicId: row.publicId, // explicit for clarity in the dashboard
    name: row.name,
    status: row.status,
    phoneNumber: row.phoneNumber,
    capabilities: row.capabilities ?? [],
    lastConnectedAt: row.lastConnectedAt,
    connectedAt: row.lastConnectedAt, // alias for backward compatibility
    createdAt: row.createdAt,
  };
}

/**
 * List the instances of a project.
 * GET /accounts/:accountId/projects/:projectPublicId/instances
 */
router.get(
  '/:accountId/projects/:projectPublicId/instances',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  scopeEnforceMiddleware.enforce,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const instances = await platformRepository.platformInstance.findMany({
        where: { projectId: context.project.id },
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
        orderBy: { createdAt: 'desc' },
      });

      res.json(instances.map(toInstanceDTO));
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Create an instance in a project.
 * POST /accounts/:accountId/projects/:projectPublicId/instances
 * Body: { name }
 *
 * Idempotent on (accountId, name): a repeat returns 200 with the
 * existing instance instead of creating a second one.
 */
router.post(
  '/:accountId/projects/:projectPublicId/instances',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  scopeEnforceMiddleware.enforce,
  idempotencyMiddleware.check,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const { name } = req.body ?? {};
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'MISSING_FIELDS', message: 'name is required' });
        return;
      }

      // Idempotent create: check for existing instance by (accountId, name) first.
      // This is the authoritative idempotency anchor for instance creation since
      // the instance name is unique per account and the client-supplied idempotency
      // key is scoped to (accountId, apiKeyId, idempotencyKey) in the middleware.
      const existing = await platformRepository.platformInstance.findFirst({
        where: { accountId: context.tenant.accountId, name },
      });

      if (existing) {
        if (existing.projectId !== context.project.id) {
          res.status(409).json({
            error: 'NAME_TAKEN',
            message: 'An instance with this name already exists in another project',
          });
          return;
        }
        const responseBody = toInstanceDTO(existing);
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
      const instance = await instanceService.create(context.tenant.accountId, context.project.id, name);

      await auditService.record(
        context.tenant.accountId,
        'INSTANCE_CREATE',
        { type: 'instance', id: instance.publicId },
        { instancePublicId: instance.publicId },
        { projectId: context.project.id },
      );

      const responseBody = toInstanceDTO(instance);

      await idempotencyMiddleware.complete(req, res, responseBody, instance.publicId);

      res.status(201).json(responseBody);
    } catch {
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

/**
 * Get instance by publicId.
 * GET /accounts/:accountId/projects/:projectPublicId/instances/:instId
 * instId is the public ID (inst_xxx).
 */
router.get(
  '/:accountId/projects/:projectPublicId/instances/:instId',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  scopeEnforceMiddleware.enforce,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const instance = await platformRepository.platformInstance.findFirst({
        where: {
          publicId: req.params.instId,
          projectId: context.project.id,
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
        ...toInstanceDTO(instance),
        ...(qrCode ? { qrCode } : {}),
      });
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Connect instance.
 * POST /accounts/:accountId/projects/:projectPublicId/instances/:instId/connect
 *
 * The response deliberately carries NO QR code: the pairing QR is
 * delivered by the SSE stream, or fetched with the GET above once the
 * engine has produced it.
 */
router.post(
  '/:accountId/projects/:projectPublicId/instances/:instId/connect',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  scopeEnforceMiddleware.enforce,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const instance = await requireProjectInstance(req, res, context.project.id);
      if (!instance) return;

      await evolutionAdapter.connectInstance(instance.id);

      await auditService.record(
        context.tenant.accountId,
        'INSTANCE_CONNECT',
        { type: 'instance', id: instance.publicId },
        { instancePublicId: instance.publicId },
        { projectId: context.project.id },
      );

      res.json({ success: true, status: 'CONNECTING' });
    } catch {
      res.status(500).json({ error: 'CONNECT_ERROR' });
    }
  },
);

/**
 * Disconnect instance.
 * POST /accounts/:accountId/projects/:projectPublicId/instances/:instId/disconnect
 */
router.post(
  '/:accountId/projects/:projectPublicId/instances/:instId/disconnect',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  scopeEnforceMiddleware.enforce,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const instance = await requireProjectInstance(req, res, context.project.id);
      if (!instance) return;

      await evolutionAdapter.disconnectInstance(instance.id);

      await auditService.record(
        context.tenant.accountId,
        'INSTANCE_DISCONNECT',
        { type: 'instance', id: instance.publicId },
        { instancePublicId: instance.publicId },
        { projectId: context.project.id },
      );

      res.json({ success: true, status: 'DISCONNECTED' });
    } catch {
      res.status(500).json({ error: 'DISCONNECT_ERROR' });
    }
  },
);

/**
 * Restart instance.
 * POST /accounts/:accountId/projects/:projectPublicId/instances/:instId/restart
 */
router.post(
  '/:accountId/projects/:projectPublicId/instances/:instId/restart',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  scopeEnforceMiddleware.enforce,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const instance = await requireProjectInstance(req, res, context.project.id);
      if (!instance) return;

      await evolutionAdapter.restartInstance(instance.id);

      await auditService.record(
        context.tenant.accountId,
        'INSTANCE_RESTART',
        { type: 'instance', id: instance.publicId },
        { instancePublicId: instance.publicId },
        { projectId: context.project.id },
      );

      res.json({ success: true, status: 'RESTARTING' });
    } catch {
      res.status(500).json({ error: 'RESTART_ERROR' });
    }
  },
);

/**
 * Get canonical instance state.
 * GET /accounts/:accountId/projects/:projectPublicId/instances/:instId/state
 * Returns CONNECTED/CONNECTING/CREATED/DISCONNECTED/SUSPENDED — never JIDs or engine refs.
 */
router.get(
  '/:accountId/projects/:projectPublicId/instances/:instId/state',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  scopeEnforceMiddleware.enforce,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const instance = await requireProjectInstance(req, res, context.project.id);
      if (!instance) return;

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
 * DELETE /accounts/:accountId/projects/:projectPublicId/instances/:instId
 */
router.delete(
  '/:accountId/projects/:projectPublicId/instances/:instId',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  scopeEnforceMiddleware.enforce,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const instance = await requireProjectInstance(req, res, context.project.id);
      if (!instance) return;

      // Disconnect first if connected
      try {
        await evolutionAdapter.disconnectInstance(instance.id);
      } catch {
        // Ignore disconnect errors when deleting
      }

      await platformRepository.platformInstance.delete({
        where: { id: instance.id },
      });

      await auditService.record(
        context.tenant.accountId,
        'INSTANCE_DELETE',
        { type: 'instance', id: instance.publicId },
        { instancePublicId: instance.publicId },
        { projectId: context.project.id },
      );

      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'DELETE_ERROR' });
    }
  },
);

/**
 * Bind API key to instance.
 * POST /accounts/:accountId/projects/:projectPublicId/api-keys/:keyId/instances/:instId/bind
 * keyId and instId are PUBLIC IDs (key_xxx and inst_xxx).
 */
router.post(
  '/:accountId/projects/:projectPublicId/api-keys/:keyId/instances/:instId/bind',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  scopeEnforceMiddleware.enforce,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      // Look up the actual API key database ID from the public ID
      const apiKey = await platformRepository.platformApiKey.findFirst({
        where: {
          publicId: req.params.keyId,
          accountId: context.tenant.accountId,
          projectId: context.project.id,
        },
      });

      if (!apiKey) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'API key not found' });
        return;
      }

      // Look up the actual instance database ID from the public ID
      const instance = await requireProjectInstance(req, res, context.project.id);
      if (!instance) return;

      // Create the binding record
      await platformRepository.platformApiKeyInstance.create({
        data: {
          apiKeyId: apiKey.id,
          instanceId: instance.id,
        },
      });

      await auditService.record(
        context.tenant.accountId,
        'API_KEY_BIND',
        { type: 'api-key-instance', id: '' },
        { apiKeyId: req.params.keyId, instanceId: req.params.instId },
        { projectId: context.project.id },
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
