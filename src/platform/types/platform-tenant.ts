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
 * The app a request is scoped to.
 *
 * `id` is the internal cuid — this is what the `appId` foreign key
 * column stores. `publicId` is the `app_xxx` external identifier.
 */
export interface PlatformTenantApp {
  id: string;
  publicId: string;
  projectId: string;
}

/**
 * The resolved tenant for a request, built by `tenantResolveMiddleware`.
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
  /**
   * The app this request is scoped to — resolved from the `X-App-Id`
   * header, the `appPublicId` query/body field, or the account's
   * default app, in that order.
   */
  defaultApp: PlatformTenantApp;
}
