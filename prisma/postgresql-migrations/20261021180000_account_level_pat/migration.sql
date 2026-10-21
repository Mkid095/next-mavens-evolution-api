-- ===========================================================
-- Account-level personal access token
-- ===========================================================
-- Every API key used to belong to exactly one project, because
-- `PlatformApiKey.projectId` was NOT NULL. That made it impossible
-- to have the credential the product needs most: one token that
-- manages every project of an account.
--
-- The column is now nullable, and the two shapes are:
--
--   projectId IS NOT NULL  — a project key. It can ONLY act inside
--                             its own project. The middleware rejects
--                             it everywhere else.
--   projectId IS NULL      — a personal access token. It can act on
--                             any project of the account it belongs to.
--
-- The existing rows keep their project, so nothing that works today
-- changes behaviour. The `ON DELETE CASCADE` on the project foreign
-- key is left in place: deleting a project still deletes its keys,
-- while an account-level token (projectId NULL) is untouched by it.

ALTER TABLE "PlatformApiKey"
  ALTER COLUMN "projectId" DROP NOT NULL;

-- The account's own personal access token. Same shape as the project
-- default token: the key row enforces it, and the plaintext is kept
-- encrypted so the Settings page can show it again at any time.
ALTER TABLE "PlatformAccount"
  ADD COLUMN IF NOT EXISTS "defaultApiKeyId" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "defaultTokenEncrypted" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultTokenPrefix" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "defaultTokenCreatedAt" TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "PlatformAccount_defaultApiKeyId_key"
  ON "PlatformAccount" ("defaultApiKeyId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PlatformAccount_defaultApiKeyId_fkey'
  ) THEN
    ALTER TABLE "PlatformAccount"
      ADD CONSTRAINT "PlatformAccount_defaultApiKeyId_fkey"
      FOREIGN KEY ("defaultApiKeyId")
      REFERENCES "PlatformApiKey" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- The account-level tokens are listed by account, and the null
-- project is what identifies them.
CREATE INDEX IF NOT EXISTS "PlatformApiKey_accountId_projectId_idx"
  ON "PlatformApiKey" ("accountId", "projectId");
