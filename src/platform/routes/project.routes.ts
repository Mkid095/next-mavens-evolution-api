import { Request, Response, Router } from 'express';

import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { platformAuthMiddleware } from '../middleware/platform-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { platformRepository } from '../repository/platform.repository';
import { appService } from '../services/app.service';
import { AuditService } from '../services/audit.service';
import { projectService } from '../services/project.service';
import { PlatformTenant } from '../types/platform-tenant';

const router: Router = Router();
const auditService = new AuditService();

/**
 * Resolve the internal app id (cuid) the caller wants to scope to.
 *
 * Behaviour:
 *  - When `publicId` is supplied, the app is looked up by its public id
 *    scoped to the authenticated tenant's account. If no such app exists
 *    an error with status 404 (`APP_NOT_FOUND`) is thrown.
 *  - When `publicId` is omitted, the account's default app is resolved
 *    (and lazily created, together with its default project, on first use).
 *
 * This helper does NOT read the `X-App-Id` header — the caller decides
 * which app public id to pass in. Note that this function is currently
 * unused by any route in this file; the tenant middleware resolves the
 * scoped app for the request instead.
 *
 * Returns the app's internal id (cuid) for use in queries.
 */
async function resolveAppId(req: Request, publicId: string | undefined): Promise<string> {
  const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
  if (!tenant) throw new Error('NO_TENANT');

  if (publicId) {
    const app = await platformRepository.platformApp.findFirst({
      where: { publicId, accountId: tenant.accountId },
      select: { id: true },
    });
    if (!app) {
      const err = new Error('APP_NOT_FOUND') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    return app.id;
  }

  // Fall back to the default app for the tenant
  const def = await appService.resolveDefault(tenant.accountId);
  return def.id;
}

// ─── Projects ───────────────────────────────────────────────────────────────

router.get(
  '/:accountId/projects',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant || tenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const projects = await projectService.list(tenant.accountId);
    res.json(projects.map(toProjectDTO));
  },
);

router.post(
  '/:accountId/projects',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  idempotencyMiddleware.check,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant || tenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const { name, description } = req.body as { name?: string; description?: string };
    if (!name || name.trim().length < 2) {
      res.status(400).json({ error: 'INVALID_NAME' });
      return;
    }
    const project = await projectService.create(tenant.accountId, { name, description });
    await auditService.record(tenant.accountId, 'PROJECT_CREATE', {
      type: 'project',
      id: project.publicId,
    });
    idempotencyMiddleware.complete(req, res, toProjectDTO(project), project.publicId);
    res.status(201).json(toProjectDTO(project));
  },
);

router.get(
  '/:accountId/projects/:projectPublicId',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant || tenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const project = await projectService.get(tenant.accountId, req.params.projectPublicId);
    if (!project) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    res.json(toProjectDTO(project));
  },
);

router.patch(
  '/:accountId/projects/:projectPublicId',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant || tenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const { name, description } = req.body as { name?: string; description?: string };
    const project = await projectService.rename(tenant.accountId, req.params.projectPublicId, {
      name,
      description,
    });
    if (!project) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    await auditService.record(tenant.accountId, 'PROJECT_UPDATE', {
      type: 'project',
      id: project.publicId,
    });
    res.json(toProjectDTO(project));
  },
);

router.post(
  '/:accountId/projects/:projectPublicId/archive',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant || tenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const project = await projectService.archive(tenant.accountId, req.params.projectPublicId);
    if (!project) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    await auditService.record(tenant.accountId, 'PROJECT_ARCHIVE', {
      type: 'project',
      id: project.publicId,
    });
    res.json({ success: true });
  },
);

// ─── Apps ───────────────────────────────────────────────────────────────────

router.get(
  '/:accountId/projects/:projectPublicId/apps',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant || tenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const apps = await appService.listByProject(tenant.accountId, req.params.projectPublicId);
    if (apps === null) {
      res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
      return;
    }
    res.json(apps.map(toAppDTO));
  },
);

router.post(
  '/:accountId/projects/:projectPublicId/apps',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  idempotencyMiddleware.check,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant || tenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const { name, description } = req.body as { name?: string; description?: string };
    if (!name || name.trim().length < 2) {
      res.status(400).json({ error: 'INVALID_NAME' });
      return;
    }
    const app = await appService.create(tenant.accountId, req.params.projectPublicId, {
      name,
      description,
    });
    if (!app) {
      res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
      return;
    }
    await auditService.record(
      tenant.accountId,
      'APP_CREATE',
      {
        type: 'app',
        id: app.publicId,
      },
      { projectId: req.params.projectPublicId },
    );
    idempotencyMiddleware.complete(req, res, toAppDTO(app), app.publicId);
    res.status(201).json(toAppDTO(app));
  },
);

router.get(
  '/:accountId/apps/:appPublicId',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant || tenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const app = await appService.get(tenant.accountId, req.params.appPublicId);
    if (!app) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    res.json(toAppDTO(app));
  },
);

router.patch(
  '/:accountId/apps/:appPublicId',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant || tenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const { name, description } = req.body as { name?: string; description?: string };
    const app = await appService.rename(tenant.accountId, req.params.appPublicId, {
      name,
      description,
    });
    if (!app) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    await auditService.record(tenant.accountId, 'APP_UPDATE', {
      type: 'app',
      id: app.publicId,
    });
    res.json(toAppDTO(app));
  },
);

router.post(
  '/:accountId/apps/:appPublicId/archive',
  platformAuthMiddleware.authenticate,
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
    if (!tenant || tenant.publicId !== req.params.accountId) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    const app = await appService.archive(tenant.accountId, req.params.appPublicId);
    if (!app) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    await auditService.record(tenant.accountId, 'APP_ARCHIVE', {
      type: 'app',
      id: app.publicId,
    });
    res.json({ success: true });
  },
);

export { router as projectRoutes, resolveAppId };

// ─── DTOs ────────────────────────────────────────────────────────────────────

function toProjectDTO(p: any) {
  return {
    id: p.publicId,
    name: p.name,
    slug: p.slug,
    description: p.description ?? null,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    apps: p.apps?.map((a: any) => ({
      id: a.publicId,
      name: a.name,
      slug: a.slug,
      status: a.status,
    })),
  };
}

function toAppDTO(a: any) {
  return {
    id: a.publicId,
    name: a.name,
    slug: a.slug,
    description: a.description ?? null,
    status: a.status,
    projectId: a.project?.publicId ?? null,
    projectName: a.project?.name ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
