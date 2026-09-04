import { Request, Response, NextFunction } from 'express';
import { IdempotencyService } from '../services/idempotency.service';
import { Logger } from '@config/logger.config';

interface PlatformKeyInfo {
  accountId: string;
  apiKeyId: string;
  scopes: string[];
}

interface PlatformTenantInfo {
  accountId: string;
  publicId: string;
  status: string;
  plan: { planId: string; name: string };
}

interface IdempotentRequest extends Request {
  platformKey?: PlatformKeyInfo;
  platformTenant?: PlatformTenantInfo;
  idempotencyKey?: string;
}

/**
 * Idempotency Middleware
 * Only active for POST/PATCH/DELETE methods.
 * Handles Idempotency-Key header for safe retries.
 *
 * Requires platformAuthMiddleware and tenantResolveMiddleware to run first
 * (they attach platformKey and platformTenant to the request).
 */
export class IdempotencyMiddleware {
  private readonly logger = new Logger('IdempotencyMiddleware');
  private readonly idempotencyService: IdempotencyService;

  constructor() {
    this.idempotencyService = new IdempotencyService();
  }

  /**
   * Check idempotency status before processing.
   * Attaches idempotency metadata to request for later completion.
   */
  public check = async (req: IdempotentRequest, res: Response, next: NextFunction): Promise<void> => {
    // Only apply to mutating methods
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      next();
      return;
    }

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (!idempotencyKey) {
      // No key provided — proceed without idempotency
      next();
      return;
    }

    // platformKey is attached by platformAuthMiddleware (runs first in chain)
    const accountId = req.platformKey?.accountId;
    const apiKeyId = req.platformKey?.apiKeyId;

    if (!accountId || !apiKeyId) {
      // No authenticated platform session — skip idempotency
      next();
      return;
    }

    try {
      const requestHash = this.idempotencyService.hashRequest(req.method, req.path, req.body);
      const result = await this.idempotencyService.checkIdempotency(
        accountId,
        apiKeyId,
        idempotencyKey,
        requestHash,
      );

      if (result.status === 'COMPLETED') {
        // Return cached response (replay)
        this.logger.debug(`Idempotency replay: ${idempotencyKey}`);
        res.status(200).json(result.cachedResponse);
        return;
      }

      if (result.status === 'CONFLICT') {
        // Same idempotency key but different request body
        res.status(409).json({
          error: 'IDEMPOTENCY_CONFLICT',
          message: 'Idempotency key already used with a different request body',
        });
        return;
      }

      if (result.status === 'PROCESSING') {
        // Another request with same key is currently being processed
        res.status(409).json({
          error: 'IDEMPOTENCY_IN_PROGRESS',
          message: 'A request with this idempotency key is already being processed',
        });
        return;
      }

      // NOT_FOUND — mark as processing and continue to handler
      await this.idempotencyService.markProcessing(
        accountId,
        apiKeyId,
        idempotencyKey,
        requestHash,
        req.method,
        req.path,
      );

      // Attach scope info to request for later completion
      req.idempotencyKey = idempotencyKey;
      next();
    } catch (error) {
      this.logger.error(`Idempotency check error: ${error}`);
      // Fail open — allow request without idempotency guarantee
      next();
    }
  };

  /**
   * Complete an idempotency record after response is sent.
   * Called by route handlers after successful mutation.
   */
  public complete = (
    req: IdempotentRequest,
    res: Response,
    responseBody: unknown,
    resourceId?: string,
  ): void => {
    const idempotencyKey = req.idempotencyKey;
    const accountId = req.platformKey?.accountId;
    const apiKeyId = req.platformKey?.apiKeyId;

    if (!idempotencyKey || !accountId || !apiKeyId) {
      return;
    }

    // Fire and forget — idempotency completion should not block the response
    this.idempotencyService
      .markCompleted(accountId, apiKeyId, idempotencyKey, responseBody, resourceId)
      .catch((error) => {
        this.logger.error(`Idempotency completion error: ${error}`);
      });
  };
}

export const idempotencyMiddleware = new IdempotencyMiddleware();
