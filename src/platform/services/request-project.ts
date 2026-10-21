import { Request } from 'express';

import { platformRepository } from '../repository/platform.repository';
import { projectService } from './project.service';
import { ProjectScope } from './project-scope.service';

/**
 * Resolve the project a request is scoped to.
 *
 * An API key IS project-scoped — it carries its project, and everything
 * it does happens inside that project. A dashboard session has no key,
 * so it falls back to the account's default project; that is what the
 * dashboard's MCP panel and the "me" endpoint report.
 */
export async function resolveRequestProject(req: Request, accountId: string): Promise<ProjectScope | null> {
  const platformKey = (req as Request & { platformKey?: { projectId?: string } }).platformKey;

  if (platformKey?.projectId) {
    const project = await platformRepository.platformProject.findFirst({
      where: { id: platformKey.projectId, accountId },
      select: { id: true, publicId: true, accountId: true },
    });
    if (project) {
      return { id: project.id, publicId: project.publicId, accountId: project.accountId };
    }
  }

  const defaultProject = await projectService.resolveDefault(accountId);
  return {
    id: defaultProject.id,
    publicId: defaultProject.publicId,
    accountId: defaultProject.accountId,
  };
}
