-- CreateEnum
CREATE TYPE "AiLedgerType" AS ENUM ('FREE_GRANT', 'PURCHASE', 'USAGE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "AiOrderStatus" AS ENUM ('CREATED', 'PAID', 'FAILED');

-- AlterTable
ALTER TABLE "ads" ADD COLUMN     "preview" JSONB;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "aiTokenBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ai_token_ledger" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "type" "AiLedgerType" NOT NULL,
    "tokens" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "feature" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "userId" TEXT,
    "workspaceId" TEXT,
    "orderId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_token_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_token_orders" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "AiOrderStatus" NOT NULL DEFAULT 'CREATED',
    "providerOrderId" TEXT,
    "paymentId" TEXT,
    "createdById" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_token_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_token_ledger_orgId_createdAt_idx" ON "ai_token_ledger"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_token_orders_providerOrderId_key" ON "ai_token_orders"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_token_orders_paymentId_key" ON "ai_token_orders"("paymentId");

-- CreateIndex
CREATE INDEX "ai_token_orders_orgId_createdAt_idx" ON "ai_token_orders"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "ai_token_ledger" ADD CONSTRAINT "ai_token_ledger_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_token_orders" ADD CONSTRAINT "ai_token_orders_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Builder drafts moved to the per-platform format (payload.version = 2); earlier drafts can't be opened.
DELETE FROM "campaign_drafts" WHERE "payload"->>'version' IS NULL AND "status" <> 'LAUNCHED';

-- Existing organizations get the same free AI tokens new sign-ups receive.
UPDATE "organizations" SET "aiTokenBalance" = 100000;
INSERT INTO "ai_token_ledger" ("id", "orgId", "type", "tokens", "balanceAfter", "note")
SELECT 'grant_' || "id", "id", 'FREE_GRANT', 100000, 100000, 'Free AI tokens' FROM "organizations";
