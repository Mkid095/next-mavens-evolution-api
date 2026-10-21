-- ===========================================================
-- Widen PlatformMessageCommand.recipient
-- ===========================================================
-- The column was VARCHAR(20), which fits an E.164 phone number
-- ("+12025550100" is 12 characters) but not a WhatsApp address:
--
--   5511999999999@s.whatsapp.net   27 characters
--   123456789012345@lid             21 characters
--
-- Clients that address a recipient by JID or LID — which the platform
-- accepts — were rejected by the database with a value-too-long
-- error. Widened to 128 so both forms fit comfortably.

ALTER TABLE "PlatformMessageCommand"
  ALTER COLUMN "recipient" TYPE VARCHAR(128);
