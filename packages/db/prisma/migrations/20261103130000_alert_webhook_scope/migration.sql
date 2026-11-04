-- AlterTable
ALTER TABLE "alert_webhooks" ADD COLUMN "workspaceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "events" TEXT[] DEFAULT ARRAY[]::TEXT[];
