-- ===========================================================
-- PlatformSetting — encrypted application settings
-- ===========================================================
-- Holds secrets that must survive a redeploy but must never appear in
-- source control. Currently the company gate password that protects
-- account creation (POST /platform/auth/signup, POST /platform/onboard).
--
-- `value` always holds AES-256-GCM ciphertext in the form
--   v1:<iv>:<authTag>:<ciphertext>
-- never plaintext. The encryption key lives in PLATFORM_ENCRYPTION_KEY,
-- which is supplied through the environment, not the repository.

CREATE TABLE "PlatformSetting" (
    "key"         VARCHAR(100) NOT NULL,
    "value"       TEXT NOT NULL,
    "description" VARCHAR(255),
    "createdAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP NOT NULL,
    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);
