/**
 * Environment every test runs with. Never the developer's .env: the database
 * and Redis point at dedicated test instances, and secrets are fixed test values.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** TEST_DATABASE_URL, else the local .env database with its name swapped for ashniva_test. */
function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const file = path.join(import.meta.dirname, "../../.env");
  const line = existsSync(file) ? readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL=")) : undefined;
  const local = line?.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  if (!local) return "postgresql://ashniva:ashniva@127.0.0.1:5434/ashniva_test";
  const u = new URL(local);
  u.pathname = "/ashniva_test";
  return u.toString();
}

// Integration workers get the per-run database through TEST_DATABASE_URL, set by test/setup/global-db.ts.
export const TEST_DATABASE_URL = testDatabaseUrl();

export function applyTestEnv() {
  Object.assign(process.env, {
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? TEST_DATABASE_URL,
    REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15",
    WEB_URL: "http://localhost:3100",
    API_PORT: "4199",
    JWT_ACCESS_SECRET: "test-access-secret-test-access-secret-0001",
    JWT_REFRESH_SECRET: "test-refresh-secret-test-refresh-secret-01",
    OAUTH_STATE_SECRET: "test-oauth-state-secret-test-oauth-state-1",
    TOKEN_ENCRYPTION_KEY: "0".repeat(63) + "1",
    SUPER_ADMIN_EMAILS: "operator@example.test",
    UPLOAD_DIR: process.env.TEST_UPLOAD_DIR ?? "/tmp/ashniva-test-uploads",
    // Nothing in a test may reach a real service.
    EMAIL_PROVIDER: "",
    SMTP_HOST: "",
    RESEND_API_KEY: "",
    RAZORPAY_KEY_ID: "",
    RAZORPAY_KEY_SECRET: "",
    RAZORPAY_WEBHOOK_SECRET: "",
    AI_API_KEY: "",
  });
  // The database name must contain "_test" (e.g. ashniva_test, ashniva_test_api2).
  if (!/\/[^/?]*_test[^/?]*(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error(`Refusing to run tests against a non-test database: ${process.env.DATABASE_URL}`);
  }
}
