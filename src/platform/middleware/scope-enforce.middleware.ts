import { Request, Response, NextFunction } from 'express';
import { platformRepository } from '../repository/platform.repository';
import { Logger } from '@config/logger.config';

/**
 * Scope Enforce Middleware
 * If request has instanceId param, verify PlatformApiKeyInstance record exists.
 * If no PlatformApiKeyInstance records for this key → key authorizes nothing → 403.
 */
export class ScopeEnforceMiddleware {
  private readonly logger = new Logger('ScopeEnforceMiddleware');

  /**
   * Enforce instance-level authorization.
   * Must be used AFTER platformAuth middleware.
   */
  public enforce = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const instanceId = req.params.instanceId ?? req.query.instanceId;

    // No instanceId in request - skip enforcement
    if (!instanceId) {
      next();
      return;
    }

    const platformKey = (req as Request & { platformKey?: { apiKeyId: string } }).platformKey;

    if (!platformKey?.apiKeyId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    try {
      // Check if this API key has any instance bindings
      const keyBindings = await platformRepository.platformApiKeyInstance.findMany({
        where: { apiKeyId: platformKey.apiKeyId },
      });

      // If key has no instance bindings at all, it cannot authorize any instance access
      if (keyBindings.length === 0) {
        res.status(403).json({
          error: 'NO_INSTANCE_ACCESS',
          message: 'This API key does not have access to any instances',
        });
        return;
      }

      // Check if this specific instance is authorized
      const hasAccess = keyBindings.some(binding => binding.instanceId === instanceId);

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
