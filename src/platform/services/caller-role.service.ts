import { Request } from 'express';

import { platformRepository } from '../repository/platform.repository';
import { PlatformTenant } from '../types/platform-tenant';

/** Roles that carry administrative authority over an account. */
export const ADMIN_ROLES: string[] = ['OWNER', 'ADMIN'];

/** The credential the caller's role was resolved from. */
export type CallerCredential = 'session' | 'apiKey' | null;

export interface CallerRoleResult {
  /** Resolved role ('OWNER' | 'ADMIN' | 'MEMBER'), or null when unresolvable. */
  role: string | null;
  /** Which credential the role was resolved from. */
  credential: CallerCredential;
  /** True when the caller may perform account-level admin actions. */
  isAdmin: boolean;
  /** Explanation used as the 403 body. Empty when `isAdmin` is true. */
  reason: string;
}

const UNRESOLVED: CallerRoleResult = {
  role: null,
  credential: null,
  isAdmin: false,
  reason: 'Caller role could not be resolved',
};

/**
 * Resolves the ROLE of the caller behind the current request.
 *
 * Two credentials can reach the platform routes:
 *
 *  1. A dashboard session (`req.platformSession`). The session stores the
 *     internal PlatformUser id, so the role is read straight off the user
 *     row (OWNER / ADMIN / MEMBER).
 *
 *  2. An API key (`req.platformKey.apiKeyId`). `PlatformApiKey` has no user
 *     column — a key belongs to the ACCOUNT, not to a person — so a
 *     per-person role cannot be resolved from it. The only administrative
 *     API credential in this system is a wildcard-scoped key (`scopes: ['*']`),
 *     which is what provisioning creates ("Initial Key" / "Default Key").
 *     A scoped key is not an administrative credential and resolves to no
 *     role at all.
 *
 * Whenever the role cannot be resolved the caller is NOT an admin: the
 * check fails closed rather than open.
 */
export class CallerRoleService {
  public async resolve(req: Request, tenant: PlatformTenant): Promise<CallerRoleResult> {
    const session = (req as Request & { platformSession?: { userId?: string; accountId?: string } }).platformSession;

    // 1. Dashboard session — role comes from the PlatformUser row.
    if (session?.userId) {
      const user = await platformRepository.platformUser.findFirst({
        where: { OR: [{ id: session.userId }, { publicId: session.userId }] },
        select: { id: true, accountId: true, role: true },
      });

      // A session that points at a user of another account (or at a user
      // that no longer exists) resolves to no role.
      if (!user || user.accountId !== tenant.accountId) {
        return { role: null, credential: 'session', isAdmin: false, reason: UNRESOLVED.reason };
      }

      const isAdmin = ADMIN_ROLES.includes(user.role);
      return {
        role: user.role,
        credential: 'session',
        isAdmin,
        reason: isAdmin ? '' : 'This action requires an account administrator (OWNER or ADMIN)',
      };
    }

    // 2. API key — no per-person role exists for a key, only the account's
    //    administrative (wildcard) credential.
    const platformKey = (
      req as Request & { platformKey?: { accountId?: string; apiKeyId?: string; scopes?: string[] } }
    ).platformKey;

    if (platformKey?.apiKeyId) {
      const key = await platformRepository.platformApiKey.findUnique({
        where: { id: platformKey.apiKeyId },
        select: { accountId: true, scopes: true },
      });

      if (!key || key.accountId !== tenant.accountId) {
        return {
          role: null,
          credential: 'apiKey',
          isAdmin: false,
          reason: 'API key does not belong to this account',
        };
      }

      const scopes = (key.scopes as unknown as string[] | null) ?? platformKey.scopes ?? [];
      if (scopes.includes('*')) {
        return { role: 'ADMIN', credential: 'apiKey', isAdmin: true, reason: '' };
      }

      return {
        role: null,
        credential: 'apiKey',
        isAdmin: false,
        reason: 'This action requires an account administrator or a wildcard-scoped API key',
      };
    }

    // 3. Nothing resolvable — fail closed.
    return { ...UNRESOLVED };
  }
}

export const callerRoleService = new CallerRoleService();
