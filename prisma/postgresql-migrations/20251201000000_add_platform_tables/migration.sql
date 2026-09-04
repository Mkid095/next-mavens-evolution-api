-- ============================================================
-- Phase 1: Platform Foundation Migration
-- Applied via: prisma migrate deploy --schema prisma/postgresql-schema.prisma
-- Target database: fidscript (NOT evolution)
-- ============================================================

-- STEP 1: Extend Instance with nullable platform fields (non-destructive)
-- These columns are NULL for all existing rows — no data modification
-- No NOT NULL, no defaults, no constraints that could break existing data
-- Prefixed with platform* to avoid name collision with existing Evolution columns

ALTER TABLE "Instance" ADD COLUMN IF NOT EXISTS "platformAccountId" VARCHAR(255);
ALTER TABLE "Instance" ADD COLUMN IF NOT EXISTS "platformPhoneNumber" VARCHAR(20);
ALTER TABLE "Instance" ADD COLUMN IF NOT EXISTS "platformStatus" VARCHAR(50);

-- STEP 2: Create all platform tables

CREATE TABLE "PlatformAccount" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "status" VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE "PlatformUser" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "accountId" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255) UNIQUE NOT NULL,
  "passwordHash" VARCHAR(255) NOT NULL,
  "role" VARCHAR(50) NOT NULL DEFAULT 'MEMBER',
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "lastLoginAt" TIMESTAMP,
  CONSTRAINT "PlatformUser_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE
);

CREATE TABLE "PlatformRateLimitPolicy" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "requestsPerMinute" INTEGER NOT NULL DEFAULT 100,
  "messagesPerMinute" INTEGER NOT NULL DEFAULT 60,
  "burstLimit" INTEGER NOT NULL DEFAULT 45,
  "webhookDeliveriesPerMinute" INTEGER NOT NULL DEFAULT 500,
  "maxInstances" INTEGER NOT NULL DEFAULT 1,
  "maxActiveInstances" INTEGER,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE "PlatformPlan" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "name" VARCHAR(100) UNIQUE NOT NULL,
  "displayName" VARCHAR(100) NOT NULL,
  "monthlyMessageLimit" INTEGER,
  "rateLimitPolicyId" VARCHAR(255) NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PlatformPlan_rateLimitPolicyId_fkey" FOREIGN KEY ("rateLimitPolicyId") REFERENCES "PlatformRateLimitPolicy"("id")
);

CREATE TABLE "PlatformSubscription" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "accountId" VARCHAR(255) NOT NULL,
  "planId" VARCHAR(255) NOT NULL,
  "status" VARCHAR(50) NOT NULL DEFAULT 'active',
  "startedAt" TIMESTAMP NOT NULL DEFAULT now(),
  "endsAt" TIMESTAMP,
  CONSTRAINT "PlatformSubscription_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE,
  CONSTRAINT "PlatformSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PlatformPlan"("id")
);

CREATE TABLE "PlatformApiKey" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "accountId" VARCHAR(255) NOT NULL,
  "keyHash" VARCHAR(64) UNIQUE NOT NULL,
  "keyPrefix" VARCHAR(16) NOT NULL,
  "name" VARCHAR(255),
  "scopes" JSONB NOT NULL DEFAULT '[]',
  "expiresAt" TIMESTAMP,
  "revokedAt" TIMESTAMP,
  "lastUsedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PlatformApiKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE
);

CREATE TABLE "PlatformApiKeyInstance" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "apiKeyId" VARCHAR(255) NOT NULL,
  "instanceId" VARCHAR(255) NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PlatformApiKeyInstance_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "PlatformApiKey"("id") ON DELETE CASCADE,
  CONSTRAINT "PlatformApiKeyInstance_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "PlatformApiKeyInstance_apiKeyId_instanceId_key" ON "PlatformApiKeyInstance"("apiKeyId", "instanceId");
CREATE INDEX "PlatformApiKeyInstance_instanceId_idx" ON "PlatformApiKeyInstance"("instanceId");

CREATE TABLE "PlatformIdempotencyRecord" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId" VARCHAR(255) NOT NULL,
  "apiKeyId" VARCHAR(255) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "method" VARCHAR(10) NOT NULL,
  "path" VARCHAR(255) NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "response" JSONB,
  "resourceId" VARCHAR(50),
  "errorCode" VARCHAR(50),
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "expiresAt" TIMESTAMP NOT NULL,
  CONSTRAINT "PlatformIdempotencyRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "PlatformIdempotencyRecord_accountId_apiKeyId_idemKey_key"
  ON "PlatformIdempotencyRecord"("accountId", "apiKeyId", "idempotencyKey");
CREATE INDEX "PlatformIdempotencyRecord_accountId_expiresAt_idx"
  ON "PlatformIdempotencyRecord"("accountId", "expiresAt");

CREATE TABLE "PlatformMessageCommand" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "accountId" VARCHAR(255) NOT NULL,
  "instanceId" VARCHAR(255) NOT NULL,
  "apiKeyId" VARCHAR(255) NOT NULL,
  "messageId" VARCHAR(50) NOT NULL,
  "type" VARCHAR(50) NOT NULL,
  "recipient" VARCHAR(20) NOT NULL,
  "content" JSONB NOT NULL,
  "status" VARCHAR(50) NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "sentAt" TIMESTAMP,
  "expiresAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PlatformMessageCommand_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE,
  CONSTRAINT "PlatformMessageCommand_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "PlatformMessageCommand_accountId_instanceId_idemKey_key"
  ON "PlatformMessageCommand"("accountId", "instanceId", "idempotencyKey");
CREATE INDEX "PlatformMessageCommand_instanceId_status_idx"
  ON "PlatformMessageCommand"("instanceId", "status");
CREATE INDEX "PlatformMessageCommand_accountId_createdAt_idx"
  ON "PlatformMessageCommand"("accountId", "createdAt");

CREATE TABLE "PlatformWebhook" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "accountId" VARCHAR(255) NOT NULL,
  "instanceId" VARCHAR(255) NOT NULL,
  "url" VARCHAR(500) NOT NULL,
  "events" JSONB NOT NULL DEFAULT '[]',
  "secret" VARCHAR(64) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PlatformWebhook_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE,
  CONSTRAINT "PlatformWebhook_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE
);

CREATE INDEX "PlatformWebhook_accountId_idx" ON "PlatformWebhook"("accountId");
CREATE INDEX "PlatformWebhook_instanceId_idx" ON "PlatformWebhook"("instanceId");
CREATE INDEX "PlatformWebhook_enabled_idx" ON "PlatformWebhook"("enabled");

CREATE TABLE "PlatformWebhookDelivery" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "publicId" VARCHAR(50) UNIQUE NOT NULL,
  "webhookId" VARCHAR(255) NOT NULL,
  "eventId" VARCHAR(50) NOT NULL,
  "deliveryId" VARCHAR(50) NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "status" VARCHAR(20) NOT NULL,
  "responseStatus" INTEGER,
  "responseTimeMs" INTEGER,
  "nextRetryAt" TIMESTAMP,
  "lastError" TEXT,
  "deliveredAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PlatformWebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "PlatformWebhook"("id") ON DELETE CASCADE
);

CREATE INDEX "PlatformWebhookDelivery_webhookId_createdAt_idx"
  ON "PlatformWebhookDelivery"("webhookId", "createdAt");
CREATE INDEX "PlatformWebhookDelivery_eventId_idx"
  ON "PlatformWebhookDelivery"("eventId");

CREATE TABLE "PlatformUsageRecord" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId" VARCHAR(255) NOT NULL,
  "instanceId" VARCHAR(255),
  "operation" VARCHAR(100) NOT NULL,
  "resource" VARCHAR(50) NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unit" VARCHAR(20) NOT NULL,
  "idempotencyKey" VARCHAR(128),
  "metadata" JSONB,
  "periodStart" TIMESTAMP NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PlatformUsageRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE
);

CREATE INDEX "PlatformUsageRecord_accountId_periodStart_idx"
  ON "PlatformUsageRecord"("accountId", "periodStart");
CREATE INDEX "PlatformUsageRecord_accountId_operation_periodStart_idx"
  ON "PlatformUsageRecord"("accountId", "operation", "periodStart");
CREATE INDEX "PlatformUsageRecord_accountId_instanceId_idx"
  ON "PlatformUsageRecord"("accountId", "instanceId");

CREATE TABLE "PlatformAuditLog" (
  "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId" VARCHAR(255) NOT NULL,
  "userId" VARCHAR(255),
  "apiKeyId" VARCHAR(255),
  "action" VARCHAR(100) NOT NULL,
  "resource" VARCHAR(100),
  "resourceId" VARCHAR(50),
  "requestId" VARCHAR(50),
  "eventId" VARCHAR(50),
  "ipAddress" VARCHAR(45),
  "userAgent" VARCHAR(500),
  "success" BOOLEAN NOT NULL DEFAULT true,
  "metadata" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PlatformAuditLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE CASCADE
);

CREATE INDEX "PlatformAuditLog_accountId_createdAt_idx"
  ON "PlatformAuditLog"("accountId", "createdAt");
CREATE INDEX "PlatformAuditLog_accountId_action_idx"
  ON "PlatformAuditLog"("accountId", "action");
CREATE INDEX "PlatformAuditLog_requestId_idx"
  ON "PlatformAuditLog"("requestId");

-- Additional indexes for PlatformAccount, PlatformApiKey, PlatformSubscription, PlatformUser
CREATE INDEX "PlatformAccount_status_idx" ON "PlatformAccount"("status");
CREATE INDEX "PlatformApiKey_accountId_idx" ON "PlatformApiKey"("accountId");
CREATE INDEX "PlatformApiKey_keyHash_idx" ON "PlatformApiKey"("keyHash");
CREATE INDEX "PlatformSubscription_accountId_idx" ON "PlatformSubscription"("accountId");
CREATE INDEX "PlatformSubscription_status_idx" ON "PlatformSubscription"("status");
CREATE INDEX "PlatformUser_accountId_idx" ON "PlatformUser"("accountId");
