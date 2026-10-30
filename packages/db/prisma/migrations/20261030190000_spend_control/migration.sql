-- AlterTable
ALTER TABLE "ad_accounts" ADD COLUMN "billing" JSONB,
ADD COLUMN "billingFetchedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN "spendAlerts" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "spend_budgets" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "monthlyLimit" DECIMAL(14,2) NOT NULL,
    "alertPercent" INTEGER NOT NULL DEFAULT 80,
    "pauseAtLimit" BOOLEAN NOT NULL DEFAULT false,
    "alertedMonth" TEXT,
    "alertedLevel" INTEGER NOT NULL DEFAULT 0,
    "pausedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spend_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spend_budgets_adAccountId_key" ON "spend_budgets"("adAccountId");

-- CreateIndex
CREATE INDEX "spend_budgets_orgId_idx" ON "spend_budgets"("orgId");

-- AddForeignKey
ALTER TABLE "spend_budgets" ADD CONSTRAINT "spend_budgets_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spend_budgets" ADD CONSTRAINT "spend_budgets_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
