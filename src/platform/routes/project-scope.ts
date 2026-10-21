import { Request, Response } from 'express';

import { platformRepository } from '../repository/platform.repository';
import { ProjectScope, projectScopeService } from '../services/project-scope.service';
import { PlatformTenant } from '../types/platform-tenant';

/**
 * The account + project a project-scoped request runs against.
 */
export interface ProjectRequestContext {
  tenant: PlatformTenant;
  project: ProjectScope;
}

/**
 * Resolve the account and the project named in the URL.
 *
 * The checks, in order:
 *   1. the request is authenticated (the tenant middleware ran);
 *   2. the account in the URL is the caller's own account — 403;
 *   3. the project exists — 404;
 *   4. the project belongs to that account — 403.
 *
 * On failure the error response is written and `null` is returned, so a
 * route handler can simply `if (!ctx) return;`.
 */
export async function requireProjectContext(req: Request, res: Response): Promise<ProjectRequestContext | null> {
  const tenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
  if (!tenant) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    return null;
  }

  if (tenant.publicId !== req.params.accountId) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'This credential does not own the requested account' });
    return null;
  }

  const resolution = await projectScopeService.resolve(tenant.accountId, req.params.projectPublicId);
  if (resolution.status === 'not_found') {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Project not found' });
    return null;
  }
  if (resolution.status === 'forbidden') {
    res.status(403).json({ error: 'FORBIDDEN', message: 'This project does not belong to the account' });
    return null;
  }

  return { tenant, project: resolution.scope };
}

/**
 * Load an instance and check that it belongs to the project.
 *
 * The instance is addressed by its public id (`inst_xxx`). An instance
 * that exists but lives in another project is reported as 404 — the
 * caller has no business knowing it exists.
 */
export async function requireProjectInstance(
  req: Request,
  res: Response,
  projectId: string,
): Promise<{ id: string; publicId: string; name: string; projectId: string } | null> {
  const instance = await platformInstanceByPublicId(req.params.instId, projectId);
  if (!instance) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Instance not found' });
    return null;
  }
  return instance;
}

/** Find an instance by its public id, scoped to a project. */
async function platformInstanceByPublicId(
  publicId: string,
  projectId: string,
): Promise<{ id: string; publicId: string; name: string; projectId: string } | null> {
  const instance = await platformRepository.platformInstance.findFirst({
    where: { publicId, projectId },
    select: { id: true, publicId: true, name: true, projectId: true },
  });
  return instance;
}
