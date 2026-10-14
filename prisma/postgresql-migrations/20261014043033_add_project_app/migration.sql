-- ===========================================================
-- Project / App hierarchy — Phase 1 of the Viventure rebuild
-- ===========================================================
-- Adds PlatformProject and PlatformApp tables; nullable appId
-- columns on seven platform tables; per-account backfill of a
-- default project + default app; FKs and NOT NULL after.

-- 1) Enums
CREATE TYPE "PlatformProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "PlatformAppStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- 2) New tables (no appId FKs yet so we can backfill first)
CREATE TABLE "PlatformProject" (
    "id"          TEXT PRIMARY KEY,
    "publicId"    VARCHAR(50) NOT NULL UNIQUE,
    "accountId"   VARCHAR(255) NOT NULL,
    "name"        VARCHAR(100) NOT NULL,
    "slug"        VARCHAR(60) NOT NULL,
    "description" VARCHAR(500),
    "status"      "PlatformProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformProject_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "PlatformProject_accountId_slug_key" ON "PlatformProject"("accountId", "slug");
CREATE INDEX "PlatformProject_accountId_idx" ON "PlatformProject"("accountId");
CREATE INDEX "PlatformProject_accountId_status_idx" ON "PlatformProject"("accountId", "status");

CREATE TABLE "PlatformApp" (
    "id"          TEXT PRIMARY KEY,
    "publicId"    VARCHAR(50) NOT NULL UNIQUE,
    "accountId"   VARCHAR(255) NOT NULL,
    "projectId"   VARCHAR(255) NOT NULL,
    "name"        VARCHAR(100) NOT NULL,
    "slug"        VARCHAR(60) NOT NULL,
    "description" VARCHAR(500),
    "status"      "PlatformAppStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformApp_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE,
    CONSTRAINT "PlatformApp_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "PlatformProject"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "PlatformApp_projectId_slug_key" ON "PlatformApp"("projectId", "slug");
CREATE INDEX "PlatformApp_accountId_idx" ON "PlatformApp"("accountId");
CREATE INDEX "PlatformApp_projectId_idx" ON "PlatformApp"("projectId");
CREATE INDEX "PlatformApp_accountId_status_idx" ON "PlatformApp"("accountId", "status");

-- 3) Nullable appId columns on existing tables
ALTER TABLE "PlatformInstance"
    ADD COLUMN "appId" VARCHAR(255);
ALTER TABLE "PlatformApiKey"
    ADD COLUMN "appId" VARCHAR(255);
ALTER TABLE "PlatformWebhook"
    ADD COLUMN "appId" VARCHAR(255);
ALTER TABLE "PlatformContact"
    ADD COLUMN "appId" VARCHAR(255);
ALTER TABLE "PlatformGroup"
    ADD COLUMN "appId" VARCHAR(255);
ALTER TABLE "PlatformMessageCommand"
    ADD COLUMN "appId" VARCHAR(255);
ALTER TABLE "PlatformUsageRecord"
    ADD COLUMN "appId" VARCHAR(255);

CREATE INDEX "PlatformInstance_appId_idx"           ON "PlatformInstance"("appId");
CREATE INDEX "PlatformInstance_accountId_appId_idx" ON "PlatformInstance"("accountId", "appId");
CREATE INDEX "PlatformApiKey_appId_idx"             ON "PlatformApiKey"("appId");
CREATE INDEX "PlatformWebhook_appId_idx"            ON "PlatformWebhook"("appId");
CREATE INDEX "PlatformContact_appId_idx"            ON "PlatformContact"("appId");
CREATE INDEX "PlatformGroup_appId_idx"              ON "PlatformGroup"("appId");
CREATE INDEX "PlatformMessageCommand_appId_idx"     ON "PlatformMessageCommand"("appId");
CREATE INDEX "PlatformUsageRecord_appId_idx"        ON "PlatformUsageRecord"("appId");

-- 4) Per-account backfill: create ("Default Project", "default") and
--    ("Default App", "default"), then set every existing row's appId.
DO $$
DECLARE
    acct RECORD;
    proj_public TEXT;
    app_public  TEXT;
    proj_id     TEXT;
    app_id      TEXT;
    rand_suffix TEXT;
BEGIN
    FOR acct IN SELECT "id" FROM "PlatformAccount" LOOP
        rand_suffix := substr(md5(random()::text), 1, 8);
        proj_public := 'proj_' || rand_suffix;
        app_public  := 'app_'  || rand_suffix;

        proj_id := 'p_' || rand_suffix;
        INSERT INTO "PlatformProject"
            ("id", "publicId", "accountId", "name", "slug", "status", "createdAt", "updatedAt")
        VALUES
            (proj_id, proj_public, acct.id, 'Default Project', 'default', 'ACTIVE',
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

        app_id := 'a_' || rand_suffix;
        INSERT INTO "PlatformApp"
            ("id", "publicId", "accountId", "projectId", "name", "slug", "status", "createdAt", "updatedAt")
        VALUES
            (app_id, app_public, acct.id, proj_id, 'Default App', 'default', 'ACTIVE',
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

        UPDATE "PlatformInstance"      SET "appId" = app_id WHERE "accountId" = acct.id;
        UPDATE "PlatformApiKey"        SET "appId" = app_id WHERE "accountId" = acct.id;
        UPDATE "PlatformWebhook"       SET "appId" = app_id WHERE "accountId" = acct.id;
        UPDATE "PlatformContact"       SET "appId" = app_id WHERE "accountId" = acct.id;
        UPDATE "PlatformGroup"         SET "appId" = app_id WHERE "accountId" = acct.id;
        UPDATE "PlatformMessageCommand" SET "appId" = app_id WHERE "accountId" = acct.id;
        UPDATE "PlatformUsageRecord"   SET "appId" = app_id WHERE "accountId" = acct.id;
    END LOOP;
END $$;

-- 5) FKs and NOT NULL on the seven tables. The loop above guarantees
--    no NULLs, so the SET NOT NULL will succeed.
ALTER TABLE "PlatformInstance"
    ALTER COLUMN "appId" SET NOT NULL;
ALTER TABLE "PlatformInstance"
    ADD CONSTRAINT "PlatformInstance_appId_fkey"
        FOREIGN KEY ("appId") REFERENCES "PlatformApp"("id") ON DELETE CASCADE;

ALTER TABLE "PlatformApiKey"
    ALTER COLUMN "appId" SET NOT NULL;
ALTER TABLE "PlatformApiKey"
    ADD CONSTRAINT "PlatformApiKey_appId_fkey"
        FOREIGN KEY ("appId") REFERENCES "PlatformApp"("id") ON DELETE CASCADE;

ALTER TABLE "PlatformWebhook"
    ALTER COLUMN "appId" SET NOT NULL;
ALTER TABLE "PlatformWebhook"
    ADD CONSTRAINT "PlatformWebhook_appId_fkey"
        FOREIGN KEY ("appId") REFERENCES "PlatformApp"("id") ON DELETE CASCADE;

ALTER TABLE "PlatformContact"
    ALTER COLUMN "appId" SET NOT NULL;
ALTER TABLE "PlatformContact"
    ADD CONSTRAINT "PlatformContact_appId_fkey"
        FOREIGN KEY ("appId") REFERENCES "PlatformApp"("id") ON DELETE CASCADE;

ALTER TABLE "PlatformGroup"
    ALTER COLUMN "appId" SET NOT NULL;
ALTER TABLE "PlatformGroup"
    ADD CONSTRAINT "PlatformGroup_appId_fkey"
        FOREIGN KEY ("appId") REFERENCES "PlatformApp"("id") ON DELETE CASCADE;

ALTER TABLE "PlatformMessageCommand"
    ALTER COLUMN "appId" SET NOT NULL;
ALTER TABLE "PlatformMessageCommand"
    ADD CONSTRAINT "PlatformMessageCommand_appId_fkey"
        FOREIGN KEY ("appId") REFERENCES "PlatformApp"("id") ON DELETE CASCADE;

ALTER TABLE "PlatformUsageRecord"
    ALTER COLUMN "appId" SET NOT NULL;
ALTER TABLE "PlatformUsageRecord"
    ADD CONSTRAINT "PlatformUsageRecord_appId_fkey"
        FOREIGN KEY ("appId") REFERENCES "PlatformApp"("id") ON DELETE CASCADE;
