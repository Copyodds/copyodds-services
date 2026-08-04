CREATE TABLE "WalletDerivationCredential" (
    "referCode" TEXT NOT NULL,
    "userId" INTEGER,
    "cipher" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "scheme" TEXT NOT NULL DEFAULT 'v3_refer_pass',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletDerivationCredential_pkey" PRIMARY KEY ("referCode")
);

CREATE UNIQUE INDEX "WalletDerivationCredential_userId_key"
ON "WalletDerivationCredential"("userId");

CREATE INDEX "WalletDerivationCredential_userId_idx"
ON "WalletDerivationCredential"("userId");

ALTER TABLE "WalletDerivationCredential"
ADD CONSTRAINT "WalletDerivationCredential_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
