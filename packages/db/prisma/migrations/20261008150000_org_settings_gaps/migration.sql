-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "brandLogoKey" TEXT;

-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" TEXT NOT NULL,
    "ruleAlerts" BOOLEAN NOT NULL DEFAULT true,
    "reportCopies" BOOLEAN NOT NULL DEFAULT true,
    "lowAiBalance" BOOLEAN NOT NULL DEFAULT true,
    "syncFailures" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
