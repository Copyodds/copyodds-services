-- New custodial rows default to Go remote signing only
ALTER TABLE "Wallet" ALTER COLUMN "signingProvider" SET DEFAULT 'GO_REMOTE';
