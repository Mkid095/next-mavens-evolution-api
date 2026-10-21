-- ===========================================================
-- Widen PlatformAuditLog.resourceId
-- ===========================================================
-- The column was VARCHAR(50), but an API_REQUEST audit row stores the
-- request path in it. A project-scoped path such as
--
--   /api/v1/accounts/acct_10632c31cc56ebee/projects/proj_9a083ec5/instances
--
-- is 71 characters, so every project-scoped request was rejected by
-- the database and never reached the log. Only the short
-- account-level paths fitted, which made the API category look
-- half-empty and hid exactly the requests a reader wants to see.

ALTER TABLE "PlatformAuditLog"
  ALTER COLUMN "resourceId" TYPE VARCHAR(255);
