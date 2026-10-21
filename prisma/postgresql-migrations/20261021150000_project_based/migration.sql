-- ===========================================================
-- Project-based hierarchy: drop the App level
-- ===========================================================
-- The hierarchy is now
--
--   PlatformAccount  acct_xxx
--    └ PlatformProject  proj_xxx
--       └ PlatformInstance  inst_xxx   (many per project)
--
-- PlatformApp existed as an extra tier between the project and the
-- instance. For an internal tool it was a level of nesting with no
-- meaning, so it is removed: every table that pointed at an app now
-- points at the app's project instead.
--
-- The data moves with it — an instance's app becomes its project, so
-- nothing changes hands, only the level it is filed under.
--
-- The project's default API token is also added here. It is stored
-- encrypted (AES-256-GCM, same key as the webhook secrets) so the
-- MCP and CLI install pages can show a working configuration at any
-- time, and `defaultApiKeyId` points at the PlatformApiKey row that
-- actually enforces it.

-- ── 1. Add the project columns, nullable at first ─────────────────────────

ALTER TABLE "PlatformInstance"       ADD COLUMN IF NOT EXISTS "projectId" VARCHAR(255);
ALTER TABLE "PlatformApiKey"        ADD COLUMN IF NOT EXISTS "projectId" VARCHAR(255);
ALTER TABLE "PlatformWebhook"       ADD COLUMN IF NOT EXISTS "projectId" VARCHAR(255);
ALTER TABLE "PlatformContact"       ADD COLUMN IF NOT EXISTS "projectId" VARCHAR(255);
ALTER TABLE "PlatformGroup"         ADD COLUMN IF NOT EXISTS "projectId" VARCHAR(255);
ALTER TABLE "PlatformMessageCommand" ADD COLUMN IF NOT EXISTS "projectId" VARCHAR(255);
ALTER TABLE "PlatformUsageRecord"   ADD COLUMN IF NOT EXISTS "projectId" VARCHAR(255);

-- ── 2. Backfill from the app's project ──────────────────────────────────

UPDATE "PlatformInstance"       t SET "projectId" = a."projectId" FROM "PlatformApp" a WHERE a.id = t."appId";
UPDATE "PlatformApiKey"        t SET "projectId" = a."projectId" FROM "PlatformApp" a WHERE a.id = t."appId";
UPDATE "PlatformWebhook"       t SET "projectId" = a."projectId" FROM "PlatformApp" a WHERE a.id = t."appId";
UPDATE "PlatformContact"       t SET "projectId" = a."projectId" FROM "PlatformApp" a WHERE a.id = t."appId";
UPDATE "PlatformGroup"         t SET "projectId" = a."projectId" FROM "PlatformApp" a WHERE a.id = t."appId";
UPDATE "PlatformMessageCommand" t SET "projectId" = a."projectId" FROM "PlatformApp" a WHERE a.id = t."appId";
UPDATE "PlatformUsageRecord"   t SET "projectId" = a."projectId" FROM "PlatformApp" a WHERE a.id = t."appId";

-- Every account has a default project (the migration backfill created
-- one), and every app belongs to a project, so nothing is left NULL.
-- The DO block makes that a hard failure rather than a silent NULL.

DO $$
DECLARE
  orphan RECORD;
BEGIN
  FOR orphan IN
    SELECT 'PlatformInstance' AS tbl, count(*) AS n FROM "PlatformInstance"       WHERE "projectId" IS NULL
    UNION ALL SELECT 'PlatformApiKey',        count(*) FROM "PlatformApiKey"        WHERE "projectId" IS NULL
    UNION ALL SELECT 'PlatformWebhook',       count(*) FROM "PlatformWebhook"       WHERE "projectId" IS NULL
    UNION ALL SELECT 'PlatformContact',       count(*) FROM "PlatformContact"       WHERE "projectId" IS NULL
    UNION ALL SELECT 'PlatformGroup',         count(*) FROM "PlatformGroup"         WHERE "projectId" IS NULL
    UNION ALL SELECT 'PlatformMessageCommand', count(*) FROM "PlatformMessageCommand" WHERE "projectId" IS NULL
    UNION ALL SELECT 'PlatformUsageRecord',   count(*) FROM "PlatformUsageRecord"   WHERE "projectId" IS NULL
  LOOP
    IF orphan.n > 0 THEN
      RAISE EXCEPTION '% rows have no project after the backfill', orphan.tbl;
    END IF;
  END LOOP;
END $$;

-- ── 3. Make the project columns required and index them ──────────────────

ALTER TABLE "PlatformInstance"       ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "PlatformApiKey"        ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "PlatformWebhook"       ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "PlatformContact"       ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "PlatformGroup"         ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "PlatformMessageCommand" ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "PlatformUsageRecord"   ALTER COLUMN "projectId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "PlatformInstance_projectId_idx"             ON "PlatformInstance" ("projectId");
CREATE INDEX IF NOT EXISTS "PlatformInstance_accountId_projectId_idx"   ON "PlatformInstance" ("accountId", "projectId");
CREATE INDEX IF NOT EXISTS "PlatformApiKey_projectId_idx"              ON "PlatformApiKey" ("projectId");
CREATE INDEX IF NOT EXISTS "PlatformApiKey_accountId_projectId_idx"    ON "PlatformApiKey" ("accountId", "projectId");
CREATE INDEX IF NOT EXISTS "PlatformWebhook_projectId_idx"             ON "PlatformWebhook" ("projectId");
CREATE INDEX IF NOT EXISTS "PlatformContact_projectId_idx"             ON "PlatformContact" ("projectId");
CREATE INDEX IF NOT EXISTS "PlatformGroup_projectId_idx"               ON "PlatformGroup" ("projectId");
CREATE INDEX IF NOT EXISTS "PlatformMessageCommand_projectId_idx"     ON "PlatformMessageCommand" ("projectId");
CREATE INDEX IF NOT EXISTS "PlatformUsageRecord_projectId_idx"        ON "PlatformUsageRecord" ("projectId");

-- ── 4. Point the foreign keys at PlatformProject ─────────────────────────

ALTER TABLE "PlatformInstance"       ADD CONSTRAINT "PlatformInstance_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "PlatformProject"(id) ON DELETE CASCADE;
ALTER TABLE "PlatformApiKey"        ADD CONSTRAINT "PlatformApiKey_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "PlatformProject"(id) ON DELETE CASCADE;
ALTER TABLE "PlatformWebhook"       ADD CONSTRAINT "PlatformWebhook_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "PlatformProject"(id) ON DELETE CASCADE;
ALTER TABLE "PlatformContact"       ADD CONSTRAINT "PlatformContact_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "PlatformProject"(id) ON DELETE CASCADE;
ALTER TABLE "PlatformGroup"         ADD CONSTRAINT "PlatformGroup_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "PlatformProject"(id) ON DELETE CASCADE;
ALTER TABLE "PlatformMessageCommand" ADD CONSTRAINT "PlatformMessageCommand_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "PlatformProject"(id) ON DELETE CASCADE;
ALTER TABLE "PlatformUsageRecord"   ADD CONSTRAINT "PlatformUsageRecord_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "PlatformProject"(id) ON DELETE CASCADE;

-- ── 5. Drop the app columns and the app table ───────────────────────────

ALTER TABLE "PlatformInstance"       DROP COLUMN IF EXISTS "appId";
ALTER TABLE "PlatformApiKey"        DROP COLUMN IF EXISTS "appId";
ALTER TABLE "PlatformWebhook"       DROP COLUMN IF EXISTS "appId";
ALTER TABLE "PlatformContact"       DROP COLUMN IF EXISTS "appId";
ALTER TABLE "PlatformGroup"         DROP COLUMN IF EXISTS "appId";
ALTER TABLE "PlatformMessageCommand" DROP COLUMN IF EXISTS "appId";
ALTER TABLE "PlatformUsageRecord"   DROP COLUMN IF EXISTS "appId";

DROP INDEX IF EXISTS "PlatformInstance_appId_idx";
DROP INDEX IF EXISTS "PlatformInstance_accountId_appId_idx";
DROP INDEX IF EXISTS "PlatformApiKey_appId_idx";
DROP INDEX IF EXISTS "PlatformApiKey_accountId_appId_idx";
DROP INDEX IF EXISTS "PlatformWebhook_appId_idx";
DROP INDEX IF EXISTS "PlatformContact_appId_idx";
DROP INDEX IF EXISTS "PlatformGroup_appId_idx";
DROP INDEX IF EXISTS "PlatformMessageCommand_appId_idx";
DROP INDEX IF EXISTS "PlatformUsageRecord_appId_idx";

DROP TABLE IF EXISTS "PlatformApp";
DROP TYPE IF EXISTS "PlatformAppStatus";

-- ── 6. The project's default API token ──────────────────────────────────

ALTER TABLE "PlatformProject"
  ADD COLUMN IF NOT EXISTS "defaultApiKeyId"       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "defaultTokenEncrypted" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultTokenPrefix"    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "defaultTokenCreatedAt" TIMESTAMP;

ALTER TABLE "PlatformProject"
  ADD CONSTRAINT "PlatformProject_defaultApiKeyId_fkey"
  FOREIGN KEY ("defaultApiKeyId") REFERENCES "PlatformApiKey"(id) ON DELETE SET NULL;

-- A key can be the default token of at most one project.
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformProject_defaultApiKeyId_key"
  ON "PlatformProject" ("defaultApiKeyId");
