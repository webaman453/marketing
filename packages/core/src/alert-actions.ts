import { createHmac, timingSafeEqual } from "node:crypto";
import { requireEnv } from "./env";

/**
 * One-click links in alerts ("Pause this campaign", "Mute alerts for 7 days"). The link carries a signed,
 * expiring claim and opens a confirmation page where the person is signed in, so a forwarded link
 * still needs a login that is allowed to change the campaign.
 */
export type AlertActionKind = "pause" | "snooze";

export interface AlertActionClaims {
  /** Action */
  a: AlertActionKind;
  /** Campaign id */
  c: string;
  /** Organization id */
  o: string;
  /** Days, for a snooze */
  d?: number;
  /** Expiry, seconds since epoch */
  e: number;
}

export const ALERT_ACTION_TTL_DAYS = 7;

const secret = () => createHmac("sha256", requireEnv("TOKEN_ENCRYPTION_KEY")).update("alert-action:v1").digest();
const sign = (body: string) => createHmac("sha256", secret()).update(body).digest("base64url");

export function signAlertAction(claims: Omit<AlertActionClaims, "e">, now = new Date()): string {
  const full: AlertActionClaims = { ...claims, e: Math.floor(now.getTime() / 1000) + ALERT_ACTION_TTL_DAYS * 86_400 };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** The claims when the token is genuine and unexpired, else null. */
export function verifyAlertAction(token: string, now = new Date()): AlertActionClaims | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AlertActionClaims;
    if ((claims.a !== "pause" && claims.a !== "snooze") || typeof claims.c !== "string" || typeof claims.o !== "string" || typeof claims.e !== "number") return null;
    return claims.e * 1000 > now.getTime() ? claims : null;
  } catch {
    return null;
  }
}

export function alertActionUrl(claims: Omit<AlertActionClaims, "e">, now = new Date()): string {
  const web = (process.env.WEB_URL || "http://localhost:3100").replace(/\/$/, "");
  return `${web}/alert-action?t=${signAlertAction(claims, now)}`;
}
