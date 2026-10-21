-- ===========================================================
-- Widen PlatformWebhook.secret
-- ===========================================================
-- The column was declared VARCHAR(64), but WebhookService.encrypt()
-- returns a hex-encoded AES-256-GCM payload of the form
--   iv(32) : authTag(32) : ciphertext(128)
-- which is 194 characters. Every webhook insert therefore failed with
-- "The provided value for the column is too long for the column's type",
-- so webhook creation has never worked.
--
-- 255 comfortably holds the 194-character form. There are no rows to
-- rewrite — the table has always been empty because inserts could not
-- succeed.

ALTER TABLE "PlatformWebhook"
  ALTER COLUMN "secret" TYPE VARCHAR(255);
