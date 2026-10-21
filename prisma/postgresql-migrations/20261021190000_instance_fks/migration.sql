-- ===========================================================
-- Make the instance relations real
-- ===========================================================
-- The Prisma schema declares an `instance` relation on PlatformContact,
-- PlatformGroup and PlatformMessageCommand, but the database never got
-- the matching foreign keys. The columns were plain VARCHARs, so
-- deleting an instance left its contacts, groups and queued messages
-- behind as orphans — rows that point at an instance that no longer
-- exists and that nothing will ever clean up.
--
-- The foreign keys are added with ON DELETE CASCADE so the rows go with
-- the instance. Orphans are removed first: a foreign key cannot be
-- added while rows that violate it exist, and an orphan is already
-- useless — its instance is gone.
--
-- PlatformUsageRecord and PlatformGroupEngineRef keep plain columns:
-- their instanceId is nullable, or it points at a group that can
-- outlive the instance, and neither should delete the other.

DELETE FROM "PlatformContact"
  WHERE NOT EXISTS (
    SELECT 1 FROM "PlatformInstance" i WHERE i.id = "PlatformContact"."instanceId"
  );

DELETE FROM "PlatformGroup"
  WHERE NOT EXISTS (
    SELECT 1 FROM "PlatformInstance" i WHERE i.id = "PlatformGroup"."instanceId"
  );

DELETE FROM "PlatformMessageCommand"
  WHERE NOT EXISTS (
    SELECT 1 FROM "PlatformInstance" i WHERE i.id = "PlatformMessageCommand"."instanceId"
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PlatformContact_instanceId_fkey'
  ) THEN
    ALTER TABLE "PlatformContact"
      ADD CONSTRAINT "PlatformContact_instanceId_fkey"
      FOREIGN KEY ("instanceId") REFERENCES "PlatformInstance" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PlatformGroup_instanceId_fkey'
  ) THEN
    ALTER TABLE "PlatformGroup"
      ADD CONSTRAINT "PlatformGroup_instanceId_fkey"
      FOREIGN KEY ("instanceId") REFERENCES "PlatformInstance" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PlatformMessageCommand_instanceId_fkey'
  ) THEN
    ALTER TABLE "PlatformMessageCommand"
      ADD CONSTRAINT "PlatformMessageCommand_instanceId_fkey"
      FOREIGN KEY ("instanceId") REFERENCES "PlatformInstance" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- The instance is looked up by its id on every message write.
CREATE INDEX IF NOT EXISTS "PlatformMessageCommand_instanceId_idx"
  ON "PlatformMessageCommand" ("instanceId");
