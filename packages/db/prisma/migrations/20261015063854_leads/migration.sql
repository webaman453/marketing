-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "source" TEXT,
    "isOrganic" BOOLEAN NOT NULL DEFAULT false,
    "formId" TEXT,
    "formName" TEXT,
    "pageId" TEXT,
    "campaignId" TEXT,
    "adGroupId" TEXT,
    "adId" TEXT,
    "externalAdId" TEXT,
    "campaignName" TEXT,
    "adGroupName" TEXT,
    "adName" TEXT,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "fields" JSONB NOT NULL,
    "createdTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leads_workspaceId_createdTime_idx" ON "leads"("workspaceId", "createdTime");

-- CreateIndex
CREATE INDEX "leads_campaignId_idx" ON "leads"("campaignId");

-- CreateIndex
CREATE INDEX "leads_adId_idx" ON "leads"("adId");

-- CreateIndex
CREATE UNIQUE INDEX "leads_orgId_platform_externalId_key" ON "leads"("orgId", "platform", "externalId");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "platform_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
