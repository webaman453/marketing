import { audit, randomToken, sha256 } from "@ashniva/core";
import { prisma, type Prisma, type User } from "@ashniva/db";
import { BRAND } from "@ashniva/shared";
import { config } from "../config";
import { esc, sendMail } from "./mailer";
import { grantOperatorOrgs } from "./org-setup";
import { isSuperAdmin } from "./serialize";

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** Emails a fresh single-use link to /verify-email. Older unused links keep working until they expire. */
export async function sendVerificationEmail(user: Pick<User, "id" | "name" | "email">) {
  const token = randomToken();
  await prisma.emailVerificationToken.create({
    data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
  });
  await sendMail({
    to: user.email,
    subject: `Verify your email for ${BRAND.name}`,
    heading: "Verify your email",
    body: `Hi ${esc(user.name)}, please confirm that this is your email address. This link expires in 24 hours. If you didn't create a ${BRAND.name} account, you can ignore this email.`,
    cta: { label: "Verify email", url: `${config().WEB_URL}/verify-email?token=${token}` },
  });
}

/**
 * Records that the user controls their address (a verify link, or a password link we emailed),
 * then grants what was waiting on it: an operator's own org becomes complimentary.
 */
export async function markEmailVerified(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) return user;
  const verified = await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  if (isSuperAdmin(verified)) {
    for (const org of await grantOperatorOrgs(tx, userId)) {
      await audit(
        {
          orgId: org.id,
          userId,
          action: "org.operator_access_granted",
          entityType: "organization",
          entityId: org.id,
          entityName: org.name,
          changes: { plan: { from: org.plan, to: "AGENCY" }, subscriptionStatus: { from: org.subscriptionStatus, to: "ACTIVE" } },
        },
        tx,
      );
    }
  }
  return verified;
}
