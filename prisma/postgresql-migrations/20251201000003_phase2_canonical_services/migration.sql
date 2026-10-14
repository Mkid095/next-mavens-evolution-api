-- ============================================================
-- Phase 2: Canonical Services Migration
-- Applied via: prisma migrate deploy --schema prisma/postgresql-schema.prisma
-- Target database: fidscript
-- Phase 1 migrations 000000, 000001, 000002 UNCHANGED
-- Uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS for idempotency
-- ============================================================

-- 1. PlatformInstance — canonical WhatsApp instance record
CREATE TABLE IF NOT EXISTS "PlatformInstance" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "accountId" VARCHAR(255) NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "status" VARCHAR(50) NOT NULL DEFAULT 'CREATED',
  "phoneNumber" VARCHAR(20),
  "capabilities" JSONB NOT NULL DEFAULT '[]',
  "lastConnectedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PlatformInstance_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformInstance_accountId_name_key"
  ON "PlatformInstance"("accountId", "name");
CREATE INDEX IF NOT EXISTS "PlatformInstance_accountId_idx" ON "PlatformInstance"("accountId");
CREATE INDEX IF NOT EXISTS "PlatformInstance_status_idx" ON "PlatformInstance"("status");

-- 2. InstanceEventLog — immutable lifecycle log (stable eventId source)
CREATE TABLE IF NOT EXISTS "InstanceEventLog" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "instanceId" VARCHAR(255) NOT NULL,
  "eventType" VARCHAR(100) NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "InstanceEventLog_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "PlatformInstance"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "InstanceEventLog_instanceId_createdAt_idx"
  ON "InstanceEventLog"("instanceId", "createdAt");

-- 3. PlatformContact — canonical contact (E.164, no JIDs)
CREATE TABLE IF NOT EXISTS "PlatformContact" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "accountId" VARCHAR(255) NOT NULL,
  "instanceId" VARCHAR(255) NOT NULL,
  "phoneNumber" VARCHAR(20) NOT NULL,
  "displayName" VARCHAR(100),
  "profilePhotoUrl" VARCHAR(500),
  "lastSeenAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PlatformContact_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformContact_accountId_phoneNumber_key"
  ON "PlatformContact"("accountId", "phoneNumber");
CREATE INDEX IF NOT EXISTS "PlatformContact_accountId_idx" ON "PlatformContact"("accountId");
CREATE INDEX IF NOT EXISTS "PlatformContact_instanceId_idx" ON "PlatformContact"("instanceId");

-- 4. PlatformGroup — canonical group (no engine JIDs in public model)
CREATE TABLE IF NOT EXISTS "PlatformGroup" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "accountId" VARCHAR(255) NOT NULL,
  "instanceId" VARCHAR(255) NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "participantCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PlatformGroup_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "PlatformGroup_accountId_idx" ON "PlatformGroup"("accountId");
CREATE INDEX IF NOT EXISTS "PlatformGroup_instanceId_idx" ON "PlatformGroup"("instanceId");

-- 5. PlatformGroupEngineRef — engine-specific JID mapping (adapter-private)
CREATE TABLE IF NOT EXISTS "PlatformGroupEngineRef" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "groupId" VARCHAR(255) NOT NULL,
  "instanceId" VARCHAR(255) NOT NULL,
  "provider" VARCHAR(50) NOT NULL,
  "groupJid" VARCHAR(100) NOT NULL,
  CONSTRAINT "PlatformGroupEngineRef_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "PlatformGroup"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformGroupEngineRef_instanceId_groupJid_key"
  ON "PlatformGroupEngineRef"("instanceId", "groupJid");

-- 6. PlatformMessageCommand — add engineRef (internal persistence metadata)
ALTER TABLE "PlatformMessageCommand"
  ADD COLUMN IF NOT EXISTS "engineRef" VARCHAR(255);

-- 7. WebhookDelivery — add unique constraint for retry tracking
--    Each delivery attempt = new row with unique (webhookId, eventId, attempt)
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformWebhookDelivery_webhookId_eventId_attempt_key"
  ON "PlatformWebhookDelivery"("webhookId", "eventId", "attempt");

-- 8. PlatformIdempotencyRecord — durable idempotency for POST/PATCH/DELETE requests
CREATE TABLE IF NOT EXISTS "PlatformIdempotencyRecord" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId" VARCHAR(255) NOT NULL,
  "apiKeyId" VARCHAR(255) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "method" VARCHAR(10) NOT NULL,
  "path" VARCHAR(255) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',
  "response" JSONB,
  "resourceId" VARCHAR(50),
  "errorCode" VARCHAR(50),
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "expiresAt" TIMESTAMP NOT NULL,
  CONSTRAINT "PlatformIdempotencyRecord_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformIdempotencyRecord_accountId_apiKeyId_idempotencyKey_key"
  ON "PlatformIdempotencyRecord"("accountId", "apiKeyId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "PlatformIdempotencyRecord_accountId_expiresAt_idx"
  ON "PlatformIdempotencyRecord"("accountId", "expiresAt");

-- 9. PlatformApiKeyInstance — binds a PlatformApiKey to an Evolution Instance
CREATE TABLE IF NOT EXISTS "PlatformApiKeyInstance" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "apiKeyId" VARCHAR(255) NOT NULL,
  "instanceId" VARCHAR(255) NOT NULL,
  CONSTRAINT "PlatformApiKeyInstance_apiKeyId_fkey"
    FOREIGN KEY ("apiKeyId") REFERENCES "PlatformApiKey"("id") ON DELETE CASCADE,
  CONSTRAINT "PlatformApiKeyInstance_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformApiKeyInstance_apiKeyId_instanceId_key"
  ON "PlatformApiKeyInstance"("apiKeyId", "instanceId");
CREATE INDEX IF NOT EXISTS "PlatformApiKeyInstance_instanceId_idx"
  ON "PlatformApiKeyInstance"("instanceId");
