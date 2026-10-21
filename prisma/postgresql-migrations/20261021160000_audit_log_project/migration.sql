-- ===========================================================
-- Project-scope the audit log
-- ===========================================================
-- The audit log is the base table behind the project-scoped logs
-- endpoint (`GET /accounts/:accountId/projects/:projectPublicId/logs`).
-- Without a project column the only way to answer "what happened in
-- THIS project" is to join every audit row against the resource it
-- refers to — which cannot work for events whose resource is gone and
-- cannot work at all for API requests (a REST call has no resource).
--
-- The column is nullable on purpose: some events are not project-scoped
-- (an account login, an account suspension), and those stay null
-- instead of being forced into a project they do not belong to.
--
-- It is a plain column and not a foreign key: an audit row is a record
-- of something that happened, and it must survive the deletion of the
-- project it refers to.

ALTER TABLE "PlatformAuditLog"
  ADD COLUMN IF NOT EXISTS "projectId" VARCHAR(255);

-- The logs endpoint filters by project and orders by creation time,
-- so the two are indexed together.
CREATE INDEX IF NOT EXISTS "PlatformAuditLog_projectId_createdAt_idx"
  ON "PlatformAuditLog" ("projectId", "createdAt");
