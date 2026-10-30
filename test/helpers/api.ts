/**
 * Supertest client for the real Express app. `as(user)` signs requests in
 * without going through /login (whose rate limit would trip in a test run).
 */
import { prisma } from "@ashniva/db";
import { randomToken, sha256 } from "@ashniva/core";
import jwt from "jsonwebtoken";
import request from "supertest";

let appPromise: Promise<import("express").Express> | null = null;

/** The API app, created once per test file (after the test env is applied). */
export async function app() {
  appPromise ??= import("../../apps/api/src/app").then((m) => m.createApp());
  return appPromise;
}

/** Cookie header for a fresh session of `user`. */
export async function sessionCookie(user: { id: string }) {
  const refresh = randomToken(48);
  const session = await prisma.session.create({
    data: { userId: user.id, tokenHash: sha256(refresh), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  const access = jwt.sign({ sid: session.id }, process.env.JWT_ACCESS_SECRET!, { subject: user.id, expiresIn: 900, issuer: "ashniva-api" });
  return `ash_at=${access}; ash_rt=${refresh}`;
}

/** Requests signed in as `user`: `await (await as(user)).get("/api/auth/me")`. */
export async function as(user: { id: string }) {
  const cookie = await sessionCookie(user);
  const server = await app();
  const wrap = (method: "get" | "post" | "put" | "patch" | "delete") => (url: string) => request(server)[method](url).set("Cookie", cookie);
  return { get: wrap("get"), post: wrap("post"), put: wrap("put"), patch: wrap("patch"), delete: wrap("delete") };
}

/** Anonymous requests. */
export async function anon() {
  return request(await app());
}
