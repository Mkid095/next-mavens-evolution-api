import { Logger } from '@config/logger.config';
import { NextFunction, Request, Response } from 'express';

import { AuditService } from '../services/audit.service';
import { projectScopeService } from '../services/project-scope.service';

/**
 * API request audit middleware.
 *
 * Every tenant-scoped REST call is recorded as an audit event so the
 * project logs endpoint has real data in its `api` category.
 *
 * What is recorded: method, path, status code, duration and the project
 * the call was made against. The request body is never recorded — it
 * carries message content and phone numbers.
 *
 * What is NOT recorded:
 *   - anything that is not a tenant-scoped `/api/v1/accounts/...` path
 *     (health checks, the SSE streams, the MCP transport, the login
 *     endpoints — they either have no tenant or are recorded by their
 *     own handler);
 *   - the logs endpoint itself, which would otherwise write a row for
 *     every read of the log;
 *   - the auth endpoints, which record their own `AUTH_*` events.
 *
 * The write happens after the response has been flushed, so it never
 * delays the caller, and a failure to write is swallowed — a broken
 * audit trail must never turn a good response into an error.
 */

/** `/api/v1/accounts/:accountId[/projects/:projectPublicId]` */
const ACCOUNT_PATH = /^\/api\/v1\/accounts\/([^/?#]+)(?:\/projects\/([^/?#]+))?/;

/** Paths under the account scope that must not be audited by this middleware. */
const SKIPPED_SUFFIXES = ['/logs'];

class ApiAuditMiddleware {
  private readonly logger = new Logger('ApiAuditMiddleware');
  private readonly auditService = new AuditService();

  public track = (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();

    res.on('finish', () => {
      void this.record(req, res, startedAt);
    });

    next();
  };

  private async record(req: Request, res: Response, startedAt: number): Promise<void> {
    try {
      const originalUrl = req.originalUrl || req.url || '';
      const match = ACCOUNT_PATH.exec(originalUrl);
      if (!match) return;

      const projectPublicId = match[2];
      const path = match[0];

      // The logs endpoint reads the audit trail — auditing the read would
      // make every page of the log write a row of its own.
      if (SKIPPED_SUFFIXES.some((suffix) => path.endsWith(suffix))) return;

      const platformKey = (req as Request & { platformKey?: { accountId?: string } }).platformKey;
      const platformTenant = (req as Request & { platformTenant?: { accountId?: string } }).platformTenant;
      const accountId = platformTenant?.accountId ?? platformKey?.accountId;
      if (!accountId) return;

      let projectId: string | null = null;
      if (projectPublicId) {
        const scope = await projectScopeService.resolveUnscoped(projectPublicId);
        projectId = scope?.id ?? null;
      }

      await this.auditService.record(
        accountId,
        'API_REQUEST',
        { type: 'api', id: path },
        {
          method: req.method,
          path,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          projectPublicId: projectPublicId ?? undefined,
        },
        { projectId },
      );
    } catch (error) {
      this.logger.warn(`Could not record the API audit event: ${error}`);
    }
  }
}

export const apiAuditMiddleware = new ApiAuditMiddleware();
