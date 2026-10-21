/**
 * Shared tenant types.
 *
 * `req.platformTenant` used to be typed by 14 separate local
 * `interface PlatformTenant` declarations in 4 different shapes, which
 * meant a field added to the runtime object was invisible to TypeScript
 * in most of the codebase. There is now exactly one declaration, and
 * every consumer imports it from here.
 */

/**
 * The resolved tenant for a request, built by `tenantResolveMiddleware`.
 *
 * The tenant carries the ACCOUNT and the PLAN. It no longer carries an
 * app: the hierarchy is Account → Project → Instance, and the project a
 * request works on is named explicitly in the route
 * (`/accounts/:accountId/projects/:projectPublicId/...`).
 */
export interface PlatformTenant {
  /** Internal PlatformAccount id (cuid). */
  accountId: string;
  /** External account id (`acct_xxx`). */
  publicId: string;
  status: string;
  plan: {
    planId: string;
    name: string;
    monthlyMessageLimit: number | null;
  };
}
