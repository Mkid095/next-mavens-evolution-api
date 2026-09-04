-- Add name column to PlatformUser (nullable)
ALTER TABLE "PlatformUser" ADD COLUMN IF NOT EXISTS "name" VARCHAR(255);
