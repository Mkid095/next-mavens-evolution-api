-- ===========================================================
-- Repoint PlatformApiKeyInstance.instanceId at PlatformInstance
-- ===========================================================
-- Same problem as PlatformWebhook.instanceId: the constraint pointed
-- at the engine's "Instance" table (a cuid) while the bind route
-- stores PlatformInstance.id (a uuid), so binding an API key to an
-- instance failed the foreign key every time.
--
-- The column now stores PlatformInstance.id, and the constraint points
-- there. Existing rows are converted through the engine instance name.

UPDATE "PlatformApiKeyInstance" b
   SET "instanceId" = p.id
  FROM "Instance" i
  JOIN "PlatformInstance" p ON p.name = i.name
 WHERE b."instanceId" = i.id;

ALTER TABLE "PlatformApiKeyInstance"
  DROP CONSTRAINT IF EXISTS "PlatformApiKeyInstance_instanceId_fkey";

ALTER TABLE "PlatformApiKeyInstance"
  ADD CONSTRAINT "PlatformApiKeyInstance_instanceId_fkey"
  FOREIGN KEY ("instanceId") REFERENCES "PlatformInstance"(id) ON DELETE CASCADE;
