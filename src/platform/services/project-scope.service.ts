import { Logger } from '@config/logger.config';

import { platformRepository } from '../repository/platform.repository';

/**
 * A project, resolved for the account that owns it.
 */
export interface ProjectScope {
  /** Internal PlatformProject id (cuid). */
  id: string;
  /** External project id (`proj_xxx`). */
  publicId: string;
  /** The owning account (internal id). */
  accountId: string;
}

/**
 * The outcome of resolving a project for an account.
 *
 * The three cases are distinct on purpose: "you do not own this" and
 * "this does not exist" are different answers, and the routes answer
 * them differently (403 vs 404).
 */
export type ProjectResolution =
  | { status: 'ok'; scope: ProjectScope }
  | { status: 'not_found' }
  | { status: 'forbidden' };

/** How long a resolved project stays in the lookup cache. */
const CACHE_TTL_MS = 60_000;

/**
 * Resolves the project a request is scoped to.
 *
 * Every project-scoped route needs the same answer: "is this project
 * inside the caller's account?". The lookup is a single indexed query,
 * but it sits on the hot path of every project-scoped call, so the
 * result is memoised for a minute.
 */
export class ProjectScopeService {
  private readonly logger = new Logger('ProjectScopeService');
  /** `${projectPublicId}` → the resolved scope (ownership included). */
  private readonly cache = new Map<string, { scope: ProjectScope; expiresAt: number }>();

  /**
   * Resolve a project by its public id and check it against an account.
   */
  public async resolve(accountId: string, projectPublicId: string): Promise<ProjectResolution> {
    if (!accountId || !projectPublicId) return { status: 'not_found' };

    const scope = await this.lookup(projectPublicId);
    if (!scope) return { status: 'not_found' };
    if (scope.accountId !== accountId) return { status: 'forbidden' };
    return { status: 'ok', scope };
  }

  /**
   * Resolve a project, ignoring ownership. Used by the audit middleware,
   * which only wants to know which project a request was made against.
   */
  public async resolveUnscoped(projectPublicId: string): Promise<ProjectScope | null> {
    return this.lookup(projectPublicId);
  }

  /**
   * Look a project up by its public id, whatever account owns it.
   */
  private async lookup(projectPublicId: string): Promise<ProjectScope | null> {
    if (!projectPublicId) return null;

    const cached = this.cache.get(projectPublicId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.scope;
    }

    const project = await platformRepository.platformProject.findUnique({
      where: { publicId: projectPublicId },
      select: { id: true, publicId: true, accountId: true },
    });

    if (!project) {
      this.cache.delete(projectPublicId);
      return null;
    }

    const scope: ProjectScope = {
      id: project.id,
      publicId: project.publicId,
      accountId: project.accountId,
    };
    this.cache.set(projectPublicId, { scope, expiresAt: Date.now() + CACHE_TTL_MS });
    return scope;
  }

  /** Drop a cached entry (called when a project is archived or deleted). */
  public invalidate(projectPublicId: string): void {
    this.cache.delete(projectPublicId);
  }
}

export const projectScopeService = new ProjectScopeService();
