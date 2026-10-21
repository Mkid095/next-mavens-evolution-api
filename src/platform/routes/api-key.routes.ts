import { Request, Response, Router } from 'express';

import { KNOWN_SCOPES } from '../mcp/tool-registry';
import { hybridAuth } from '../middleware/hybrid-auth.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { accountTokenService } from '../services/account-token.service';
import { AuditService } from '../services/audit.service';
import { callerRoleService } from '../services/caller-role.service';
import { PlatformAuthService } from '../services/platform-auth.service';
import { projectTokenService } from '../services/project-token.service';
import { getSessionService } from './auth.routes';
import { requireAccountContext, requireProjectContext } from './project-scope';

const router: Router = Router();
const authService = new PlatformAuthService();
const auditService = new AuditService();

/**
 * Does the caller hold the given scope?
 *
 * A dashboard session is a full login for the account, so it is not
 * scope-limited the way a personal access token is. An API key must
 * carry the scope (or the `*` wildcard).
 */
function hasScope(req: Request, scope: string): boolean {
  const session = (req as Request & { platformSession?: unknown }).platformSession;
  if (session) return true;

  const scopes = (req as Request & { platformKey?: { scopes?: string[] } }).platformKey?.scopes ?? [];
  return scopes.includes('*') || scopes.includes(scope);
}

/**
 * List the API keys of a project.
 * GET /accounts/:accountId/projects/:projectPublicId/api-keys
 *
 * Never returns the key hash or the plaintext — only public metadata.
 */
router.get(
  '/:accountId/projects/:projectPublicId/api-keys',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const keys = await authService.listApiKeys(context.tenant.accountId, context.project.id);

      res.json(
        keys.map((k) => ({
          id: k.publicId,
          name: k.name,
          scopes: k.scopes,
          // Safe to expose: the prefix is the first 16 chars of the key
          // ("fidscript_sk_" + 4 hex). The hash and plaintext never leave the server.
          keyPrefix: k.keyPrefix,
          createdAt: k.createdAt,
          expiresAt: k.expiresAt,
          revokedAt: k.revokedAt,
          lastUsedAt: k.lastUsedAt,
        })),
      );
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Create an API key in a project.
 * POST /accounts/:accountId/projects/:projectPublicId/api-keys
 * Body: { name, scopes }
 *
 * The plaintext key is returned ONCE, at creation.
 */
router.post(
  '/:accountId/projects/:projectPublicId/api-keys',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  idempotencyMiddleware.check,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const { name, scopes } = req.body ?? {};
      const requestedScopes: string[] = Array.isArray(scopes) ? scopes : [];

      // Reject a scope the platform does not recognise. A key carrying a
      // misspelled scope is silently useless — it grants nothing and the
      // holder has no way to tell.
      const unknownScopes = requestedScopes.filter((s) => !KNOWN_SCOPES.includes(s));
      if (unknownScopes.length > 0) {
        res.status(400).json({
          error: 'UNKNOWN_SCOPE',
          message: `Unknown scope${unknownScopes.length > 1 ? 's' : ''}: ${unknownScopes.join(', ')}`,
          knownScopes: KNOWN_SCOPES,
        });
        return;
      }

      // A wildcard-scoped key ('*') is the account's ADMINISTRATIVE credential —
      // it is one of the credentials the admin-only account routes accept — so
      // only an account admin (OWNER/ADMIN) may create one. Members may still
      // create scoped keys.
      if (requestedScopes.includes('*')) {
        const caller = await callerRoleService.resolve(req, context.tenant);
        if (!caller.isAdmin) {
          res.status(403).json({ error: 'FORBIDDEN', message: caller.reason });
          return;
        }
      }

      const { publicId, plaintextKey } = await authService.createApiKey(
        context.tenant.accountId,
        context.project.id,
        name ?? 'Unnamed Key',
        requestedScopes,
        undefined,
      );

      await auditService.record(
        context.tenant.accountId,
        'API_KEY_CREATE',
        { type: 'api-key', id: publicId },
        undefined,
        { projectId: context.project.id },
      );

      const responseBody = { id: publicId, name, scopes: requestedScopes, apiKey: plaintextKey };
      await idempotencyMiddleware.complete(req, res, responseBody, publicId);
      res.status(201).json(responseBody);
    } catch {
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

/**
 * Revoke an API key (sets revokedAt to now).
 * DELETE /accounts/:accountId/projects/:projectPublicId/api-keys/:keyId
 * keyId is the public ID (key_xxx).
 */
router.delete(
  '/:accountId/projects/:projectPublicId/api-keys/:keyId',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const ok = await authService.revokeApiKey(req.params.keyId, context.tenant.accountId);
      if (!ok) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      await auditService.record(
        context.tenant.accountId,
        'API_KEY_REVOKE',
        { type: 'api-key', id: req.params.keyId },
        undefined,
        { projectId: context.project.id },
      );

      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'REVOKE_ERROR' });
    }
  },
);

/**
 * The project's default token.
 * GET /accounts/:accountId/projects/:projectPublicId/api-keys/default
 *
 * The token is generated on first read and its PLAINTEXT is returned —
 * that is the whole point of the endpoint: the MCP install page and the
 * CLI need a ready-to-paste credential at any time.
 */
router.get(
  '/:accountId/projects/:projectPublicId/api-keys/default',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      if (!hasScope(req, 'api_keys:read')) {
        res.status(403).json({
          error: 'FORBIDDEN',
          message: 'Required scope: api_keys:read',
        });
        return;
      }

      const token = await projectTokenService.get(context.project.id);
      if (!token) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Project not found' });
        return;
      }

      res.json(token);
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Rotate the project's default token.
 * POST /accounts/:accountId/projects/:projectPublicId/api-keys/default/rotate
 *
 * The previous key is revoked immediately, so the old token stops
 * working the moment this returns.
 */
router.post(
  '/:accountId/projects/:projectPublicId/api-keys/default/rotate',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      if (!hasScope(req, 'api_keys:write')) {
        res.status(403).json({
          error: 'FORBIDDEN',
          message: 'Required scope: api_keys:write',
        });
        return;
      }

      const token = await projectTokenService.rotate(context.project.id);
      if (!token) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Project not found' });
        return;
      }

      await auditService.record(
        context.tenant.accountId,
        'API_KEY_ROTATE_DEFAULT',
        { type: 'api-key', id: token.id },
        undefined,
        { projectId: context.project.id },
      );

      res.json(token);
    } catch {
      res.status(500).json({ error: 'ROTATE_ERROR' });
    }
  },
);

/**
 * The account's personal access tokens.
 *
 * GET /accounts/:accountId/api-keys
 *
 * These are the keys that are NOT scoped to a project: they can act on
 * every project of the account. The project-scoped keys live under
 * `/:accountId/projects/:projectPublicId/api-keys`.
 */
router.get(
  '/:accountId/api-keys',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireAccountContext(req, res);
      if (!context) return;

      const keys = await authService.listAccountApiKeys(context.tenant.accountId);

      res.json(
        keys.map((k) => ({
          id: k.publicId,
          name: k.name,
          scopes: k.scopes,
          keyPrefix: k.keyPrefix,
          createdAt: k.createdAt,
          expiresAt: k.expiresAt,
          revokedAt: k.revokedAt,
          lastUsedAt: k.lastUsedAt,
        })),
      );
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Create an account-level personal access token.
 * POST /accounts/:accountId/api-keys
 * Body: { name, scopes }
 *
 * The plaintext key is returned ONCE, at creation.
 */
router.post(
  '/:accountId/api-keys',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  idempotencyMiddleware.check,
  async (req: Request, res: Response) => {
    try {
      const context = await requireAccountContext(req, res);
      if (!context) return;

      const { name, scopes } = req.body ?? {};
      const requestedScopes: string[] = Array.isArray(scopes) ? scopes : [];

      const unknownScopes = requestedScopes.filter((s) => !KNOWN_SCOPES.includes(s));
      if (unknownScopes.length > 0) {
        res.status(400).json({
          error: 'UNKNOWN_SCOPE',
          message: `Unknown scope${unknownScopes.length > 1 ? 's' : ''}: ${unknownScopes.join(', ')}`,
          knownScopes: KNOWN_SCOPES,
        });
        return;
      }

      // A wildcard-scoped token is the account's administrative credential,
      // so only an account admin may create one.
      if (requestedScopes.includes('*')) {
        const caller = await callerRoleService.resolve(req, context.tenant);
        if (!caller.isAdmin) {
          res.status(403).json({ error: 'FORBIDDEN', message: caller.reason });
          return;
        }
      }

      const { publicId, plaintextKey } = await authService.createApiKey(
        context.tenant.accountId,
        null, // no project — this token manages every project
        name ?? 'Personal access token',
        requestedScopes,
        undefined,
      );

      await auditService.record(
        context.tenant.accountId,
        'API_KEY_CREATE',
        { type: 'api-key', id: publicId },
        { projectId: null },
        { projectId: null },
      );

      const responseBody = { id: publicId, name, scopes: requestedScopes, apiKey: plaintextKey };
      await idempotencyMiddleware.complete(req, res, responseBody, publicId);
      res.status(201).json(responseBody);
    } catch {
      res.status(500).json({ error: 'CREATE_ERROR' });
    }
  },
);

/**
 * The account's personal access token, including the plaintext.
 * GET /accounts/:accountId/api-keys/default
 *
 * The token is generated on first read and its PLAINTEXT is returned —
 * the Settings page needs a ready-to-paste credential at any time.
 */
router.get(
  '/:accountId/api-keys/default',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireAccountContext(req, res);
      if (!context) return;

      if (!hasScope(req, 'api_keys:read')) {
        res.status(403).json({ error: 'FORBIDDEN', message: 'Required scope: api_keys:read' });
        return;
      }

      const token = await accountTokenService.get(context.tenant.accountId);
      if (!token) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Account not found' });
        return;
      }

      res.json(token);
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

/**
 * Rotate the account's personal access token.
 * POST /accounts/:accountId/api-keys/default/rotate
 *
 * The previous key is revoked immediately, so the old token stops
 * working the moment this returns.
 */
router.post(
  '/:accountId/api-keys/default/rotate',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireAccountContext(req, res);
      if (!context) return;

      if (!hasScope(req, 'api_keys:write')) {
        res.status(403).json({ error: 'FORBIDDEN', message: 'Required scope: api_keys:write' });
        return;
      }

      const token = await accountTokenService.rotate(context.tenant.accountId);
      if (!token) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Account not found' });
        return;
      }

      await auditService.record(
        context.tenant.accountId,
        'API_KEY_ROTATE_DEFAULT',
        { type: 'api-key', id: token.id },
        { projectId: null },
        { projectId: null },
      );

      res.json(token);
    } catch {
      res.status(500).json({ error: 'ROTATE_ERROR' });
    }
  },
);

/**
 * Revoke an account-level personal access token.
 * DELETE /accounts/:accountId/api-keys/:keyId
 */
router.delete(
  '/:accountId/api-keys/:keyId',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireAccountContext(req, res);
      if (!context) return;

      const ok = await authService.revokeApiKey(req.params.keyId, context.tenant.accountId);
      if (!ok) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }

      await auditService.record(
        context.tenant.accountId,
        'API_KEY_REVOKE',
        { type: 'api-key', id: req.params.keyId },
        { projectId: null },
        { projectId: null },
      );

      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'REVOKE_ERROR' });
    }
  },
);

export { router as apiKeyRoutes };
