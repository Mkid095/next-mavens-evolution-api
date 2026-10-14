import crypto from 'crypto';
import { platformRepository } from '../repository/platform.repository';
import { Logger } from '@config/logger.config';

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
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'project';
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
      include: {
        apps: { select: { id: true, publicId: true, name: true, slug: true, status: true } },
      },
    });
  }

  async get(accountId: string, projectPublicId: string) {
    return platformRepository.platformProject.findFirst({
      where: { publicId: projectPublicId, accountId },
      include: {
        apps: { select: { id: true, publicId: true, name: true, slug: true, status: true } },
      },
    });
  }

  /**
   * Resolve the default project for an account (slug = 'default').
   * Created on-demand if missing — used by the tenant-resolve
   * middleware as a back-compat fallback.
   */
  async resolveDefault(accountId: string) {
    let project = await platformRepository.platformProject.findFirst({
      where: { accountId, slug: 'default' },
    });
    if (project) return project;
    // Lazy-create: this is safe because every existing account was
    // already given a default project by the migration backfill.
    return this.create(accountId, { name: 'Default Project' });
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

  async rename(
    accountId: string,
    projectPublicId: string,
    input: { name?: string; description?: string },
  ) {
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
    // Soft-delete: apps inside are also archived so they stop appearing
    // in the dashboard's default-app lookup.
    await platformRepository.platformApp.updateMany({
      where: { projectId: project.id, status: { not: 'ARCHIVED' } },
      data: { status: 'ARCHIVED' },
    });
    return platformRepository.platformProject.update({
      where: { id: project.id },
      data: { status: 'ARCHIVED' },
    });
  }
}

export const projectService = new ProjectService();
