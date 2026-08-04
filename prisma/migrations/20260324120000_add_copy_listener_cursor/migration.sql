-- CreateTable
CREATE TABLE "CopyListenerCursor" (
    "key" TEXT NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyListenerCursor_pkey" PRIMARY KEY ("key")
);
