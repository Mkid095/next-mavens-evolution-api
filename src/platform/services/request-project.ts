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
 * The project a request named, if it named one.
 *
 * An account-level personal access token names the project it acts on with
 * the `X-Viventure-Project` header. A project-scoped key already knows its
 * project, so a header is only meaningful — and only an error — when it
 * names a different one.
 */
export function readProjectHint(req: Request): string | null {
  const hint = req.headers[PROJECT_HINT_HEADER];
  const wanted = Array.isArray(hint) ? hint[0] : hint;
  return typeof wanted === 'string' && wanted.trim() ? wanted.trim() : null;
}

/**
 * Is the caller a key that is scoped to a DIFFERENT project than the one
 * the request named?
 *
 * The REST routes answer 403 for this. The MCP gateway has to answer too:
 * silently acting on the key's own project when the caller named another
 * one is worse than an error — the caller gets another project's data and
 * has no way to know.
 */
export function keyIsScopedElsewhere(req: Request, projectId: string): boolean {
  const key = (req as Request & { platformKey?: { apiKeyId?: string; projectId?: string | null } }).platformKey;
  if (!key?.apiKeyId) return false; // a session — a full login for the account
  if (!key.projectId) return false; // an account-level personal access token
  return key.projectId !== projectId;
}

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
