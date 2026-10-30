import { randomToken, sha256 } from "@ashniva/core";
import { prisma } from "@ashniva/db";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config, isProd } from "../config";
import { unauthorized } from "./errors";

export const ACCESS_COOKIE = "ash_at";
export const REFRESH_COOKIE = "ash_rt";

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessClaims {
  sub: string;
  sid: string;
}

function cookieBase() {
  return { httpOnly: true, secure: isProd(), sameSite: "lax" as const, path: "/" };
}

function signAccess(userId: string, sessionId: string) {
  return jwt.sign({ sid: sessionId } satisfies Omit<AccessClaims, "sub">, config().JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: ACCESS_TTL_SEC,
    issuer: "ashniva-api",
  });
}

export function verifyAccess(token: string): AccessClaims {
  try {
    const claims = jwt.verify(token, config().JWT_ACCESS_SECRET, { issuer: "ashniva-api" }) as jwt.JwtPayload;
    return { sub: String(claims.sub), sid: String(claims.sid) };
  } catch {
    throw unauthorized("Your session has expired.");
  }
}

function setCookies(res: Response, access: string, refresh: string) {
  res.cookie(ACCESS_COOKIE, access, { ...cookieBase(), maxAge: ACCESS_TTL_SEC * 1000 });
  res.cookie(REFRESH_COOKIE, refresh, { ...cookieBase(), maxAge: REFRESH_TTL_MS });
}

export function clearSessionCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, cookieBase());
  res.clearCookie(REFRESH_COOKIE, cookieBase());
}

/** Starts a new session and sets auth cookies. */
export async function startSession(req: Request, res: Response, userId: string) {
  const refresh = randomToken(48);
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(refresh),
      userAgent: req.get("user-agent")?.slice(0, 300),
      ip: req.ip,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  setCookies(res, signAccess(userId, session.id), refresh);
  return session;
}

/**
 * A rotated refresh token is retired with its expiry set to the moment it was
 * revoked; a session ended by signing out (logout, password change or reset)
 * keeps its original expiry. Only the former is a sign of token theft.
 */
const wasRotated = (s: { revokedAt: Date | null; expiresAt: Date }) => s.revokedAt != null && s.expiresAt.getTime() === s.revokedAt.getTime();

/**
 * Rotates the refresh token. Presenting an already-rotated token signals
 * theft, so every session of that user is revoked. A token whose session was
 * simply signed out is refused without touching the user's other sessions.
 */
export async function rotateSession(req: Request, res: Response) {
  const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!presented) throw unauthorized();

  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(presented) } });
  if (!session) throw unauthorized();
  if (session.revokedAt && !wasRotated(session)) {
    clearSessionCookies(res);
    throw unauthorized("You were signed out. Please sign in again.");
  }
  if (session.revokedAt) {
    await prisma.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    clearSessionCookies(res);
    throw unauthorized("Your session was ended for security reasons. Please sign in again.");
  }
  if (session.expiresAt < new Date()) throw unauthorized();

  const refresh = randomToken(48);
  const next = await prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.session.update({ where: { id: session.id }, data: { revokedAt: now, expiresAt: now } });
    return tx.session.create({
      data: {
        userId: session.userId,
        tokenHash: sha256(refresh),
        userAgent: req.get("user-agent")?.slice(0, 300),
        ip: req.ip,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
  });
  setCookies(res, signAccess(session.userId, next.id), refresh);
  return next;
}

export async function endSession(req: Request, res: Response) {
  const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (presented) {
    await prisma.session.updateMany({ where: { tokenHash: sha256(presented), revokedAt: null }, data: { revokedAt: new Date() } });
  }
  clearSessionCookies(res);
}
