-- CreateTable
CREATE TABLE "UserSettings" (
    "userId" INTEGER NOT NULL,
    "displayPnlInUsd" BOOLEAN NOT NULL DEFAULT true,
    "showDemoData" BOOLEAN NOT NULL DEFAULT true,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "tradeDetected" BOOLEAN NOT NULL DEFAULT true,
    "orderPlaced" BOOLEAN NOT NULL DEFAULT true,
    "orderFailed" BOOLEAN NOT NULL DEFAULT true,
    "orderFilled" BOOLEAN NOT NULL DEFAULT true,
    "orderCancelled" BOOLEAN NOT NULL DEFAULT true,
    "budgetWarning" BOOLEAN NOT NULL DEFAULT true,
    "budgetLow" BOOLEAN NOT NULL DEFAULT true,
    "autoClaim" BOOLEAN NOT NULL DEFAULT true,
    "sessionExpiring" BOOLEAN NOT NULL DEFAULT true,
    "securityNoticeSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
