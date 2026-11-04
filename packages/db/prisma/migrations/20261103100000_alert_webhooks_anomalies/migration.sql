-- CreateEnum
CREATE TYPE "WebhookKind" AS ENUM ('SLACK', 'WEBHOOK');

-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN "anomalyAlerts" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "alert_webhooks" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "WebhookKind" NOT NULL,
    "urlEnc" TEXT NOT NULL,
    "urlHint" TEXT NOT NULL,
    "secretEnc" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMP(3),
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_webhooks_orgId_idx" ON "alert_webhooks"("orgId");

-- AddForeignKey
ALTER TABLE "alert_webhooks" ADD CONSTRAINT "alert_webhooks_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
