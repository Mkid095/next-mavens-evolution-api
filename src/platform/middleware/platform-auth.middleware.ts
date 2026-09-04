import { Request, Response, NextFunction } from 'express';
import { PlatformAuthService } from '../services/platform-auth.service';
import { Logger } from '@config/logger.config';

/**
 * Platform Auth Middleware
 * Extracts X-API-Key header, validates, and attaches key info to request.
 */
export class PlatformAuthMiddleware {
  private readonly logger = new Logger('PlatformAuthMiddleware');
  private readonly authService: PlatformAuthService;

  constructor() {
    this.authService = new PlatformAuthService();
  }

  /**
   * Authenticate request via X-API-Key header.
   * Attaches { accountId, apiKeyId, scopes } to request if valid.
   */
  public authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const apiKey = req.headers['x-api-key'] as string | undefined;

    if (!apiKey) {
      res.status(401).json({ error: 'MISSING_API_KEY', message: 'X-API-Key header is required' });
      return;
    }

    try {
      const keyInfo = await this.authService.validateApiKey(apiKey);

      if (!keyInfo) {
        res.status(401).json({ error: 'INVALID_API_KEY', message: 'API key is invalid or expired' });
        return;
      }

      // Attach to request for downstream use
      (req as Request & { platformKey?: { accountId: string; apiKeyId: string; scopes: string[] } }).platformKey = {
        accountId: keyInfo.accountId,
        apiKeyId: keyInfo.id,
        scopes: keyInfo.scopes,
      };

      next();
    } catch (error) {
      this.logger.error(`Auth middleware error: ${error}`);
      res.status(500).json({ error: 'AUTH_ERROR', message: 'Authentication failed' });
    }
  };

  /**
   * Optional auth - sets platformKey if present, but doesn't require it.
   */
  public optionalAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const apiKey = req.headers['x-api-key'] as string | undefined;

    if (!apiKey) {
      next();
      return;
    }

    try {
      const keyInfo = await this.authService.validateApiKey(apiKey);
      if (keyInfo) {
        (req as Request & { platformKey?: { accountId: string; apiKeyId: string; scopes: string[] } }).platformKey = {
          accountId: keyInfo.accountId,
          apiKeyId: keyInfo.id,
          scopes: keyInfo.scopes,
        };
      }
    } catch {
      // Ignore auth errors for optional auth
    }

    next();
  };

  /**
   * Require specific scope(s).
   */
  public requireScope = (...requiredScopes: string[]) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      const platformKey = (req as Request & { platformKey?: { accountId: string; apiKeyId: string; scopes: string[] } }).platformKey;

      if (!platformKey) {
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
        return;
      }

      const hasScope = requiredScopes.some(scope => platformKey.scopes.includes(scope));
      if (!hasScope) {
        res.status(403).json({ error: 'FORBIDDEN', message: `Required scope: ${requiredScopes.join(' or ')}` });
        return;
      }

      next();
    };
  };
}

export const platformAuthMiddleware = new PlatformAuthMiddleware();
