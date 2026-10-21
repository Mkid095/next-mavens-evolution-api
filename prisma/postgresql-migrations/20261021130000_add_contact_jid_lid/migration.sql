-- ===========================================================
-- Expose JID and LID on PlatformContact
-- ===========================================================
-- WhatsApp addresses a contact by two different identifiers:
--
--   JID  5511999999999@s.whatsapp.net  the phone-number address
--   LID  123456789012345@lid          a privacy-preserving alias for
--                                      the same person
--
-- The platform only stored the phone number, so a developer could
-- neither address a contact by JID nor tell which contacts had a
-- known LID. Both are now first-class columns, and the contact sync
-- populates them.

ALTER TABLE "PlatformContact"
  ADD COLUMN IF NOT EXISTS "jid" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "lid" VARCHAR(100);

CREATE INDEX IF NOT EXISTS "PlatformContact_accountId_jid_idx"
  ON "PlatformContact" ("accountId", "jid");

CREATE INDEX IF NOT EXISTS "PlatformContact_accountId_lid_idx"
  ON "PlatformContact" ("accountId", "lid");
