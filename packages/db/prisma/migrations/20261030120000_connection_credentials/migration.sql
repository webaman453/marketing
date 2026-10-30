-- Each organization's own API keys for platforms that connect without a sign-in.
ALTER TABLE "platform_connections" ADD COLUMN "credentialsEnc" TEXT;
