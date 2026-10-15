-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CreativeType" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('DRAFT', 'LAUNCHING', 'LAUNCHED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ReportFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "RuleFrequency" AS ENUM ('HOURLY', 'DAILY');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "billingCustomerId" TEXT,
ADD COLUMN     "billingProvider" TEXT,
ADD COLUMN     "billingSubscriptionId" TEXT,
ADD COLUMN     "brandColor" TEXT,
ADD COLUMN     "brandLogoUrl" TEXT,
ADD COLUMN     "brandName" TEXT,
ADD COLUMN     "currentPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "reportFooter" TEXT,
ADD COLUMN     "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "creatives" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CreativeType" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "storageKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "tags" TEXT[],
    "platformAssets" JSONB,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_drafts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB NOT NULL,
    "results" JSONB,
    "createdById" TEXT,
    "launchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "scheduleFrequency" "ReportFrequency",
    "scheduleHour" INTEGER,
    "scheduleDayOfWeek" INTEGER,
    "scheduleDayOfMonth" INTEGER,
    "recipients" TEXT[],
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "shareToken" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_runs" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL,
    "recipients" TEXT[],
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rules" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "scope" JSONB NOT NULL,
    "conditionLogic" TEXT NOT NULL DEFAULT 'ALL',
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "lookbackDays" INTEGER NOT NULL DEFAULT 3,
    "frequency" "RuleFrequency" NOT NULL DEFAULT 'DAILY',
    "cooldownHours" INTEGER NOT NULL DEFAULT 24,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_runs" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "evaluated" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "rule_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_targets" (
    "ruleId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "lastActionAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rule_targets_pkey" PRIMARY KEY ("ruleId","campaignId")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "creatives_storageKey_key" ON "creatives"("storageKey");

-- CreateIndex
CREATE INDEX "creatives_workspaceId_createdAt_idx" ON "creatives"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "campaign_drafts_workspaceId_updatedAt_idx" ON "campaign_drafts"("workspaceId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "reports_shareToken_key" ON "reports"("shareToken");

-- CreateIndex
CREATE INDEX "reports_workspaceId_idx" ON "reports"("workspaceId");

-- CreateIndex
CREATE INDEX "reports_nextRunAt_idx" ON "reports"("nextRunAt");

-- CreateIndex
CREATE INDEX "report_runs_reportId_createdAt_idx" ON "report_runs"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "rules_isActive_nextRunAt_idx" ON "rules"("isActive", "nextRunAt");

-- CreateIndex
CREATE INDEX "rules_workspaceId_idx" ON "rules"("workspaceId");

-- CreateIndex
CREATE INDEX "rule_runs_ruleId_startedAt_idx" ON "rule_runs"("ruleId", "startedAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_orgId_idx" ON "api_keys"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_billingSubscriptionId_key" ON "organizations"("billingSubscriptionId");

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rules" ADD CONSTRAINT "rules_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rules" ADD CONSTRAINT "rules_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_runs" ADD CONSTRAINT "rule_runs_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_targets" ADD CONSTRAINT "rule_targets_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
