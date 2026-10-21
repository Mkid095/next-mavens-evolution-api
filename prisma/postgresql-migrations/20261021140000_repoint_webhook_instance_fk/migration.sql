-- ===========================================================
-- Repoint PlatformWebhook.instanceId at PlatformInstance
-- ===========================================================
-- The foreign key left by the original platform migration pointed
-- PlatformWebhook.instanceId at the engine's "Instance" table (a
-- cuid). The delivery path does not use that id:
--
--   lifecycle-event.worker.ts selects webhooks with
--     where: { enabled: true, instanceId: event.instanceId }
--   and InstanceEventLog.instanceId is a PlatformInstance.id.
--
-- So a webhook row could never match an event, and — once the REST
-- route started storing the public instance id — the insert failed the
-- foreign key outright.
--
-- The column now stores PlatformInstance.id, and the constraint points
-- there. Existing rows are converted through the engine instance name,
-- which is what links the two tables.

-- 1. Convert existing rows from the engine instance id to the
--    PlatformInstance id. The engine row and the platform row share
--    the same name.
UPDATE "PlatformWebhook" w
   SET "instanceId" = p.id
  FROM "Instance" i
  JOIN "PlatformInstance" p ON p.name = i.name
 WHERE w."instanceId" = i.id;

-- 2. Repoint the constraint.
ALTER TABLE "PlatformWebhook"
  DROP CONSTRAINT IF EXISTS "PlatformWebhook_instanceId_fkey";

ALTER TABLE "PlatformWebhook"
  ADD CONSTRAINT "PlatformWebhook_instanceId_fkey"
  FOREIGN KEY ("instanceId") REFERENCES "PlatformInstance"(id) ON DELETE CASCADE;
