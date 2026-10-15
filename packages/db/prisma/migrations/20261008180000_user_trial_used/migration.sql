-- AlterTable
ALTER TABLE "users" ADD COLUMN "trialUsedAt" TIMESTAMP(3);

-- Everyone who already owns an org has had their trial.
UPDATE "users" u SET "trialUsedAt" = u."createdAt"
WHERE EXISTS (SELECT 1 FROM "memberships" m WHERE m."userId" = u."id" AND m."role" = 'OWNER');
