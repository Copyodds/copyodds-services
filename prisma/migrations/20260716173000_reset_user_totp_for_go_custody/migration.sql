-- User TOTP secrets are now owned exclusively by Go wallet-api. Existing Node-held
-- enrollment cannot be transferred safely, so every user must enroll again.
-- Keep the columns for rolling-deploy/schema compatibility; runtime code no longer reads them.
UPDATE "User"
SET
  "totpSecretEncrypted" = NULL,
  "totpEnabledAt" = NULL,
  "totpPendingSecretEncrypted" = NULL,
  "totpPendingCreatedAt" = NULL
WHERE
  "totpSecretEncrypted" IS NOT NULL
  OR "totpEnabledAt" IS NOT NULL
  OR "totpPendingSecretEncrypted" IS NOT NULL
  OR "totpPendingCreatedAt" IS NOT NULL;
