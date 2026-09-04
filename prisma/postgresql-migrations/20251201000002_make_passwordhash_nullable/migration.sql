-- Make passwordHash nullable for PlatformUser
-- Phase 1 platform authentication uses API keys, not passwords
ALTER TABLE "PlatformUser" ALTER COLUMN "passwordHash" DROP NOT NULL;
