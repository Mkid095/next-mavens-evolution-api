import { Request, Response, Router } from 'express';

import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { platformAuthMiddleware } from '../middleware/platform-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { AuditService } from '../services/audit.service';
import { projectService } from '../services/project.service';
import { projectScopeService } from '../services/project-scope.service';
import { PlatformTenant } from '../types/platform-tenant';

const router: Router = Router();
const auditService = new AuditService();

// ─── Projects ───────────────────────────────────────────────────────────────

/**
 * List the projects of the account.
 * GET /accounts/:accountId/projects
 */
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

/**
 * Create a project.
 * POST /accounts/:accountId/projects
 */
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
    await auditService.record(
      tenant.accountId,
      'PROJECT_CREATE',
      { type: 'project', id: project.publicId },
      undefined,
      { projectId: project.id },
    );
    idempotencyMiddleware.complete(req, res, toProjectDTO(project), project.publicId);
    res.status(201).json(toProjectDTO(project));
  },
);

/**
 * Get a project.
 * GET /accounts/:accountId/projects/:projectPublicId
 */
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

/**
 * Update a project.
 * PATCH /accounts/:accountId/projects/:projectPublicId
 */
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
    await auditService.record(
      tenant.accountId,
      'PROJECT_UPDATE',
      { type: 'project', id: project.publicId },
      undefined,
      { projectId: project.id },
    );
    res.json(toProjectDTO(project));
  },
);

/**
 * Archive a project.
 * POST /accounts/:accountId/projects/:projectPublicId/archive
 */
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
    projectScopeService.invalidate(project.publicId);
    await auditService.record(
      tenant.accountId,
      'PROJECT_ARCHIVE',
      { type: 'project', id: project.publicId },
      undefined,
      { projectId: project.id },
    );
    res.json({ success: true });
  },
);

export { router as projectRoutes };

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
  };
}
