import { Logger } from '@config/logger.config';
import { NextFunction, Request, Response } from 'express';

import { platformRepository } from '../repository/platform.repository';
import { PlatformTenant } from '../types/platform-tenant';

/**
 * Scope Enforce Middleware
 *
 * Enforces instance-level authorisation for API keys that have been
 * explicitly bound to instances.
 *
 * Semantics:
 *   - a key with NO bindings is unrestricted (it is an account-wide key);
 *   - a key WITH bindings may only act on the instances it is bound to.
 *
 * The previous behaviour — a key with no bindings being denied every
 * instance-scoped route — was wrong and only stayed dormant because the
 * middleware looked for a param name no route used.
 */
export class ScopeEnforceMiddleware {
  private readonly logger = new Logger('ScopeEnforceMiddleware');

  /**
   * Enforce instance-level authorization.
   * Must be used AFTER platformAuth and tenantResolve.
   */
  public enforce = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Routes name the instance `:instId`; `instanceId` is accepted for
    // anything that follows the older convention.
    const requested = req.params.instanceId ?? req.params.instId ?? (req.query.instanceId as string | undefined);

    // No instance in the request — nothing to enforce.
    if (!requested) {
      next();
      return;
    }

    const platformKey = (req as Request & { platformKey?: { apiKeyId: string } }).platformKey;

    if (!platformKey?.apiKeyId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    try {
      // Check if this API key has any instance bindings.
      const keyBindings = await platformRepository.platformApiKeyInstance.findMany({
        where: { apiKeyId: platformKey.apiKeyId },
        select: { instanceId: true },
      });

      // No bindings: this is an account-wide key, so it is not restricted.
      if (keyBindings.length === 0) {
        next();
        return;
      }

      // Bindings exist, so the requested instance must be one of them.
      // The binding stores the internal PlatformInstance id, while the
      // request may carry the public `inst_xxx`, so resolve it first.
      const platformTenant = (req as Request & { platformTenant?: PlatformTenant }).platformTenant;
      const instance = await platformRepository.platformInstance.findFirst({
        where: {
          accountId: platformTenant?.accountId,
          OR: [{ publicId: requested }, { id: requested }],
        },
        select: { id: true },
      });

      if (!instance) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Instance not found' });
        return;
      }

      const hasAccess = keyBindings.some((binding) => binding.instanceId === instance.id);

      if (!hasAccess) {
        res.status(403).json({
          error: 'INSTANCE_ACCESS_DENIED',
          message: 'This API key does not have access to the requested instance',
        });
        return;
      }

      next();
    } catch (error) {
      this.logger.error(`Scope enforce error: ${error}`);
      res.status(500).json({ error: 'SCOPE_ERROR', message: 'Authorization check failed' });
    }
  };
}

export const scopeEnforceMiddleware = new ScopeEnforceMiddleware();
