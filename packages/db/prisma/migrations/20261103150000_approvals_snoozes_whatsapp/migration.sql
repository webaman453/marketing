-- AlterEnum
ALTER TYPE "WebhookKind" ADD VALUE 'WHATSAPP';

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'APPLIED', 'DISMISSED', 'EXPIRED', 'FAILED');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "anomalyEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "anomalySpikeRatio" DOUBLE PRECISION NOT NULL DEFAULT 2,
ADD COLUMN "anomalyDeadDays" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "rules" ADD COLUMN "requireApproval" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "rule_suggestions" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "actions" JSONB NOT NULL,
    "values" JSONB NOT NULL,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anomaly_snoozes" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anomaly_snoozes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_suggestions_workspaceId_status_createdAt_idx" ON "rule_suggestions"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "rule_suggestions_ruleId_campaignId_status_idx" ON "rule_suggestions"("ruleId", "campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "anomaly_snoozes_campaignId_key" ON "anomaly_snoozes"("campaignId");

-- CreateIndex
CREATE INDEX "anomaly_snoozes_until_idx" ON "anomaly_snoozes"("until");

-- AddForeignKey
ALTER TABLE "rule_suggestions" ADD CONSTRAINT "rule_suggestions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomaly_snoozes" ADD CONSTRAINT "anomaly_snoozes_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
