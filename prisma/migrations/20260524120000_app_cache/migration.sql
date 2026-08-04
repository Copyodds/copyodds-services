CREATE TABLE "app_cache" (
    "key" VARCHAR(512) NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_cache_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "app_cache_expiresAt_idx" ON "app_cache"("expiresAt");
