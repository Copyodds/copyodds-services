-- CreateTable
CREATE TABLE "passkey_credentials" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "credentialId" VARCHAR(256) NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "algorithm" INTEGER NOT NULL,
    "aaguid" VARCHAR(36),
    "label" VARCHAR(128),
    "sign_count" INTEGER NOT NULL DEFAULT 0,
    "backupEligible" BOOLEAN NOT NULL DEFAULT false,
    "backupState" BOOLEAN NOT NULL DEFAULT false,
    "cloneWarning" BOOLEAN NOT NULL DEFAULT false,
    "transports" VARCHAR(128),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "passkey_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passkey_challenges" (
    "requestId" VARCHAR(64) NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" INTEGER NOT NULL,
    "challenge" VARCHAR(128) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "passkey_challenges_pkey" PRIMARY KEY ("requestId")
);

-- CreateIndex
CREATE UNIQUE INDEX "passkey_credentials_credentialId_key" ON "passkey_credentials"("credentialId");

-- CreateIndex
CREATE INDEX "passkey_credentials_userId_idx" ON "passkey_credentials"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "passkey_challenges_userId_kind_key" ON "passkey_challenges"("userId", "kind");

-- AddForeignKey
ALTER TABLE "passkey_credentials" ADD CONSTRAINT "passkey_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
