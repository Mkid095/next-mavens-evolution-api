import { Logger } from '@config/logger.config';
import crypto from 'crypto';

import { platformRepository } from '../repository/platform.repository';
import { projectService } from './project.service';

/**
 * Service for PlatformApp CRUD.
 *
 * Apps always belong to a project. Operations are tenant-scoped via
 * the project/account pair to keep ownership checks straightforward.
 */
export class AppService {
  private readonly logger = new Logger('AppService');

  private slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 56) || 'app'
    );
  }

  private randomSuffix(): string {
    return crypto.randomBytes(3).toString('hex');
  }

  private async uniqueSlug(projectId: string, name: string): Promise<string> {
    const base = this.slugify(name);
    const existing = await platformRepository.platformApp.findFirst({
      where: { projectId, slug: base },
      select: { id: true },
    });
    if (!existing) return base;
    return `${base}-${this.randomSuffix()}`;
  }

  /** List every app in the account (across all projects). */
  async list(accountId: string) {
    return platformRepository.platformApp.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      include: {
        project: { select: { id: true, publicId: true, name: true, slug: true } },
      },
    });
  }

  async listByProject(accountId: string, projectPublicId: string) {
    const project = await platformRepository.platformProject.findFirst({
      where: { publicId: projectPublicId, accountId },
      select: { id: true },
    });
    if (!project) return null;
    return platformRepository.platformApp.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(accountId: string, appPublicId: string) {
    return platformRepository.platformApp.findFirst({
      where: { publicId: appPublicId, accountId },
      include: {
        project: { select: { id: true, publicId: true, name: true, slug: true } },
      },
    });
  }

  /**
   * Resolve the default app for an account. Used by tenant-resolve
   * when no X-App-Id header is provided.
   *
   * NOTE: the row is written directly (NOT through `create()`) because
   * `create()` derives the slug from the name via `slugify()`, which
   * would produce `default-app` instead of the literal `default` slug
   * this lookup expects — causing a new project+app pair to be created
   * on every call.
   */
  async resolveDefault(accountId: string) {
    const existing = await platformRepository.platformApp.findFirst({
      where: { accountId, slug: 'default' },
      include: { project: true },
    });
    if (existing) return existing;

    // Lazy-create the default project + app if missing.
    const project = await projectService.resolveDefault(accountId);

    try {
      return await platformRepository.platformApp.create({
        data: {
          id: `a_${crypto.randomBytes(8).toString('hex')}`,
          publicId: `app_${crypto.randomBytes(8).toString('hex')}`,
          accountId,
          projectId: project.id,
          name: 'Default App',
          slug: 'default',
          description: null,
          status: 'ACTIVE',
        },
        include: { project: true },
      });
    } catch (error) {
      // UNIQUE(projectId, slug) — a concurrent request won the race.
      if ((error as { code?: string })?.code === 'P2002') {
        const raced = await platformRepository.platformApp.findFirst({
          where: { accountId, slug: 'default' },
          include: { project: true },
        });
        if (raced) return raced;
      }
      throw error;
    }
  }

  async create(accountId: string, projectPublicId: string, input: { name: string; description?: string }) {
    const project = await platformRepository.platformProject.findFirst({
      where: { publicId: projectPublicId, accountId },
      select: { id: true },
    });
    if (!project) return null;
    const slug = await this.uniqueSlug(project.id, input.name);
    const publicId = `app_${crypto.randomBytes(8).toString('hex')}`;
    const id = `a_${crypto.randomBytes(8).toString('hex')}`;
    return platformRepository.platformApp.create({
      data: {
        id,
        publicId,
        accountId,
        projectId: project.id,
        name: input.name.trim().slice(0, 100),
        slug,
        description: input.description?.trim().slice(0, 500) ?? null,
        status: 'ACTIVE',
      },
    });
  }

  async rename(accountId: string, appPublicId: string, input: { name?: string; description?: string }) {
    const app = await this.get(accountId, appPublicId);
    if (!app) return null;
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      data.name = input.name.trim().slice(0, 100);
      data.slug = await this.uniqueSlug(app.projectId, input.name);
    }
    if (input.description !== undefined) {
      data.description = input.description?.trim().slice(0, 500) ?? null;
    }
    if (Object.keys(data).length === 0) return app;
    return platformRepository.platformApp.update({
      where: { id: app.id },
      data,
    });
  }

  async archive(accountId: string, appPublicId: string) {
    const app = await this.get(accountId, appPublicId);
    if (!app) return null;
    return platformRepository.platformApp.update({
      where: { id: app.id },
      data: { status: 'ARCHIVED' },
    });
  }
}

export const appService = new AppService();
