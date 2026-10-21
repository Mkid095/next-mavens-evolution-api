import { Request } from 'express';

import { platformRepository } from '../repository/platform.repository';
import { projectService } from './project.service';
import { ProjectScope } from './project-scope.service';

/**
 * The header an account-level personal access token uses to say which
 * project it is acting on. A project key already knows its project; a
 * token that manages every project does not, so it names one.
 */
const PROJECT_HINT_HEADER = 'x-viventure-project';

/**
 * Resolve the project a request is scoped to.
 *
 * An API key IS project-scoped — it carries its project, and everything
 * it does happens inside that project. A dashboard session has no key,
 * so it falls back to the account's default project; that is what the
 * dashboard's MCP panel and the "me" endpoint report.
 *
 * An account-level personal access token (a key with no project) is the
 * third case: it can act on any project of the account, so it names
 * the one it wants with the `X-Viventure-Project` header. Without the
 * header it falls back to the account's default project.
 */
export async function resolveRequestProject(req: Request, accountId: string): Promise<ProjectScope | null> {
  const platformKey = (req as Request & { platformKey?: { apiKeyId?: string; projectId?: string | null } }).platformKey;

  if (platformKey?.projectId) {
    const project = await platformRepository.platformProject.findFirst({
      where: { id: platformKey.projectId, accountId },
      select: { id: true, publicId: true, accountId: true },
    });
    if (project) {
      return { id: project.id, publicId: project.publicId, accountId: project.accountId };
    }
  }

  // Only an account-level TOKEN honours the hint. A dashboard session
  // keeps resolving to the default project, so the console behaves
  // exactly as it did before.
  if (platformKey?.apiKeyId) {
    const hint = req.headers[PROJECT_HINT_HEADER];
    const wanted = Array.isArray(hint) ? hint[0] : hint;
    if (typeof wanted === 'string' && wanted.trim()) {
      const project = await platformRepository.platformProject.findFirst({
        where: {
          accountId,
          OR: [{ publicId: wanted.trim() }, { slug: wanted.trim() }],
        },
        select: { id: true, publicId: true, accountId: true },
      });
      if (project) {
        return { id: project.id, publicId: project.publicId, accountId: project.accountId };
      }
    }
  }

  const defaultProject = await projectService.resolveDefault(accountId);
  return {
    id: defaultProject.id,
    publicId: defaultProject.publicId,
    accountId: defaultProject.accountId,
  };
}
