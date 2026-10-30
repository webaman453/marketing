import { hashPassword, randomToken, sha256, verifyPassword } from "@ashniva/core";
import { prisma } from "@ashniva/db";
import {
  BRAND,
  acceptInviteSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
  verifyEmailSchema,
} from "@ashniva/shared";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { config } from "../config";
import { badRequest, conflict, HttpError, notFound, parse, unauthorized } from "../lib/errors";
import { markEmailVerified, sendVerificationEmail } from "../lib/email-verification";
import { esc, sendMail } from "../lib/mailer";
import { createOwnedOrg, newOrgSlug } from "../lib/org-setup";
import { buildMe, toUserDTO } from "../lib/serialize";
import { clearSessionCookies, endSession, rotateSession, startSession } from "../lib/session";
import { logger } from "../lib/logger";
import { requireAuth } from "../middleware/auth";
import { verifyAccess, ACCESS_COOKIE } from "../lib/session";

export const authRouter = Router();

const RESET_TTL_MS = 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Please wait a few minutes and try again." } },
});

// Equalizes login timing for unknown emails so accounts can't be enumerated.
const DUMMY_HASH = await hashPassword(randomToken(16));

authRouter.post("/register", authLimiter, async (req, res) => {
  const input = parse(registerSchema, req.body);
  if (await prisma.user.findUnique({ where: { email: input.email } })) {
    throw conflict("An account with this email already exists. Try signing in instead.");
  }

  const orgSlug = await newOrgSlug(input.companyName);
  const passwordHash = await hashPassword(input.password);

  const user = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { name: input.name, email: input.email, passwordHash } });
    // Unverified, so never an operator yet: their org turns complimentary when they verify.
    await createOwnedOrg(tx, user.id, input.companyName, orgSlug, "unpaid");
    return user;
  });

  await sendVerificationEmail(user);
  await startSession(req, res, user.id);
  res.status(201).json(await buildMe(user.id));
});

authRouter.post("/login", authLimiter, async (req, res) => {
  const input = parse(loginSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");
  await startSession(req, res, user.id);
  res.json(await buildMe(user.id));
});

authRouter.post("/refresh", async (req, res) => {
  try {
    await rotateSession(req, res);
  } catch (err) {
    // Drop dead cookies so the browser stops presenting them.
    clearSessionCookies(res);
    throw err;
  }
  res.status(204).end();
});

authRouter.post("/logout", async (req, res) => {
  await endSession(req, res);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json(await buildMe(req.userId!));
});

authRouter.patch("/me", requireAuth, async (req, res) => {
  const input = parse(updateProfileSchema, req.body);
  const user = await prisma.user.update({ where: { id: req.userId! }, data: { name: input.name } });
  res.json(toUserDTO(user));
});

authRouter.post("/change-password", requireAuth, authLimiter, async (req, res) => {
  const input = parse(changePasswordSchema, req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
  if (!(await verifyPassword(input.currentPassword, user.passwordHash ?? DUMMY_HASH))) {
    throw new HttpError(422, "VALIDATION_ERROR", "Current password is incorrect.", {
      currentPassword: ["Current password is incorrect."],
    });
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.newPassword) } }),
    // Sign out every other device.
    prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null, id: { not: req.sessionId } },
      data: { revokedAt: new Date() },
    }),
  ]);
  res.status(204).end();
});

authRouter.post("/forgot-password", authLimiter, async (req, res) => {
  const { email } = parse(forgotPasswordSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  // Same response whether or not the account exists.
  if (user) {
    const token = randomToken();
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    await sendMail({
      to: user.email,
      subject: `Reset your ${BRAND.name} password`,
      heading: "Reset your password",
      body: `Hi ${esc(user.name)}, we received a request to reset your password. This link expires in 1 hour. If you didn't ask for this, you can ignore this email.`,
      cta: { label: "Reset password", url: `${config().WEB_URL}/reset-password?token=${token}` },
    });
  } else {
    // Only in the server log, so support can tell why no email arrived.
    logger.info({ email }, "Password reset requested for an email with no account");
  }
  res.status(204).end();
});

authRouter.post("/reset-password", authLimiter, async (req, res) => {
  const input = parse(resetPasswordSchema, req.body);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(input.token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw badRequest("This reset link is invalid or has expired. Please request a new one.");
  }
  const passwordHash = await hashPassword(input.password);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    await tx.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await tx.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    // The link was emailed to them, so it proves they own the address (also how admin-created accounts get verified).
    await markEmailVerified(tx, record.userId);
  });
  res.status(204).end();
});

// ───────── Email verification ─────────

/** Public, so the link works in whichever browser the email opens in. */
authRouter.post("/verify-email", authLimiter, async (req, res) => {
  const { token } = parse(verifyEmailSchema, req.body);
  const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw badRequest("This verification link is invalid or has expired. Sign in and send yourself a new one.");
  }
  await prisma.$transaction(async (tx) => {
    await tx.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await markEmailVerified(tx, record.userId);
  });
  res.status(204).end();
});

authRouter.post("/resend-verification", requireAuth, authLimiter, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
  if (user.emailVerifiedAt) {
    res.status(204).end();
    return;
  }
  const last = await prisma.emailVerificationToken.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
  if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new HttpError(429, "RATE_LIMITED", "We just sent a link. Please wait a minute before asking for another.");
  }
  await sendVerificationEmail(user);
  res.status(204).end();
});

// ───────── Invitations (public lookup + accept) ─────────

async function findInvitation(token: string) {
  const invite = await prisma.invitation.findUnique({
    where: { tokenHash: sha256(token) },
    include: { org: true, invitedBy: { select: { name: true } } },
  });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) throw notFound("Invitation");
  return invite;
}

authRouter.get("/invitations/:token", async (req, res) => {
  const invite = await findInvitation(req.params.token);
  const existing = await prisma.user.findUnique({ where: { email: invite.email }, select: { id: true } });
  res.json({
    email: invite.email,
    orgName: invite.org.name,
    role: invite.role,
    invitedBy: invite.invitedBy?.name ?? null,
    hasAccount: Boolean(existing),
  });
});

authRouter.post("/invitations/accept", authLimiter, async (req, res) => {
  const input = parse(acceptInviteSchema, req.body);
  const invite = await findInvitation(input.token);
  let user = await prisma.user.findUnique({ where: { email: invite.email } });

  if (user) {
    // Existing accounts must be signed in as the invited email.
    const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
    const claims = token ? verifyAccess(token) : null;
    if (claims?.sub !== user.id) throw unauthorized(`Sign in as ${invite.email} to accept this invitation.`);
  } else {
    if (!input.name || !input.password) throw badRequest("Enter your name and a password to create your account.");
    user = await prisma.user.create({
      data: {
        name: input.name,
        email: invite.email,
        passwordHash: await hashPassword(input.password),
        // Accepting an emailed invite proves ownership of the address.
        emailVerifiedAt: new Date(),
      },
    });
  }

  const userId = user.id;
  await prisma.$transaction(async (tx) => {
    const membership = await tx.membership.upsert({
      where: { userId_orgId: { userId, orgId: invite.orgId } },
      create: { userId, orgId: invite.orgId, role: invite.role },
      update: {},
    });
    const valid = await tx.workspace.findMany({
      where: { id: { in: invite.workspaceIds }, orgId: invite.orgId, archivedAt: null },
      select: { id: true },
    });
    if (valid.length) {
      await tx.membershipWorkspace.createMany({
        data: valid.map((w) => ({ membershipId: membership.id, workspaceId: w.id })),
        skipDuplicates: true,
      });
    }
    await tx.invitation.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
  });

  await startSession(req, res, userId);
  res.json(await buildMe(userId));
});
