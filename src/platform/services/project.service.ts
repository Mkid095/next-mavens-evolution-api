import { Logger } from '@config/logger.config';
import crypto from 'crypto';

import { platformRepository } from '../repository/platform.repository';

/**
 * Service for PlatformProject CRUD.
 *
 * All operations are scoped to a single PlatformAccount (tenant
 * isolation is enforced by every query's `where` clause).
 */
export class ProjectService {
  private readonly logger = new Logger('ProjectService');

  /** Generate a URL-safe slug from a project name. */
  private slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 56) || 'project'
    );
  }

  /** Random 6-char suffix for slug disambiguation. */
  private randomSuffix(): string {
    return crypto.randomBytes(3).toString('hex');
  }

  /**
   * Slugify and ensure uniqueness within the account. If a collision
   * happens, append a 6-char random suffix and try again.
   */
  private async uniqueSlug(accountId: string, name: string): Promise<string> {
    const base = this.slugify(name);
    const existing = await platformRepository.platformProject.findFirst({
      where: { accountId, slug: base },
      select: { id: true },
    });
    if (!existing) return base;
    return `${base}-${this.randomSuffix()}`;
  }

  async list(accountId: string) {
    return platformRepository.platformProject.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(accountId: string, projectPublicId: string) {
    return platformRepository.platformProject.findFirst({
      where: { publicId: projectPublicId, accountId },
    });
  }

  /**
   * Resolve the default project for an account (slug = 'default').
   * Created on-demand if missing — used as the fallback project for
   * callers that authenticate with a dashboard session instead of a
   * project-scoped API key.
   *
   * NOTE: the row is written directly (NOT through `create()`) because
   * `create()` derives the slug from the name via `slugify()`, which
   * would produce `default-project` instead of the literal `default`
   * slug this lookup expects — causing a new project to be created
   * on every call.
   */
  async resolveDefault(accountId: string) {
    const existing = await platformRepository.platformProject.findFirst({
      where: { accountId, slug: 'default' },
    });
    if (existing) return existing;

    try {
      return await platformRepository.platformProject.create({
        data: {
          id: `p_${crypto.randomBytes(8).toString('hex')}`,
          publicId: `proj_${crypto.randomBytes(8).toString('hex')}`,
          accountId,
          name: 'Default Project',
          slug: 'default',
          description: null,
          status: 'ACTIVE',
        },
      });
    } catch (error) {
      // UNIQUE(accountId, slug) — a concurrent request won the race.
      if ((error as { code?: string })?.code === 'P2002') {
        const raced = await platformRepository.platformProject.findFirst({
          where: { accountId, slug: 'default' },
        });
        if (raced) return raced;
      }
      throw error;
    }
  }

  async create(accountId: string, input: { name: string; description?: string }) {
    const slug = await this.uniqueSlug(accountId, input.name);
    const publicId = `proj_${crypto.randomBytes(8).toString('hex')}`;
    const id = `p_${crypto.randomBytes(8).toString('hex')}`;
    return platformRepository.platformProject.create({
      data: {
        id,
        publicId,
        accountId,
        name: input.name.trim().slice(0, 100),
        slug,
        description: input.description?.trim().slice(0, 500) ?? null,
        status: 'ACTIVE',
      },
    });
  }

  async rename(accountId: string, projectPublicId: string, input: { name?: string; description?: string }) {
    const project = await this.get(accountId, projectPublicId);
    if (!project) return null;
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      data.name = input.name.trim().slice(0, 100);
      // Recompute slug on rename so the URL stays accurate
      data.slug = await this.uniqueSlug(accountId, input.name);
    }
    if (input.description !== undefined) {
      data.description = input.description?.trim().slice(0, 500) ?? null;
    }
    if (Object.keys(data).length === 0) return project;
    return platformRepository.platformProject.update({
      where: { id: project.id },
      data,
    });
  }

  async archive(accountId: string, projectPublicId: string) {
    const project = await this.get(accountId, projectPublicId);
    if (!project) return null;
    // Soft-delete. The instances, keys and webhooks that hang off the
    // project are cascade-deleted with the project row itself.
    return platformRepository.platformProject.update({
      where: { id: project.id },
      data: { status: 'ARCHIVED' },
    });
  }
}

export const projectService = new ProjectService();
