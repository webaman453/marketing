/**
 * Runs once before the integration project. Each run gets its own fresh
 * database (unless TEST_DATABASE_URL is set, as in CI), so two runs at the
 * same time — two terminals, two sessions — can't wipe each other's data.
 * Every migration is applied, and the run's database is dropped afterwards.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { TEST_DATABASE_URL, applyTestEnv } from "./env";

function adminClient(url: string) {
  const admin = new URL(url);
  admin.pathname = "/postgres";
  return new pg.Client({ connectionString: admin.toString() });
}

export default async function setup() {
  const fixed = Boolean(process.env.TEST_DATABASE_URL);
  const url = new URL(TEST_DATABASE_URL);
  if (!fixed) url.pathname = `/ashniva_test_run_${Date.now().toString(36)}_${process.pid}`;
  // Test workers start after this and inherit the variable, so they all use this run's database.
  process.env.TEST_DATABASE_URL = url.toString();
  applyTestEnv();
  const dbName = url.pathname.slice(1);

  const client = adminClient(url.toString());
  await client.connect();
  const exists = await client.query("select 1 from pg_database where datname = $1", [dbName]);
  if (exists.rowCount === 0) await client.query(`create database "${dbName}"`);
  await client.end();

  execFileSync("pnpm", ["--filter", "@ashniva/db", "exec", "prisma", "migrate", "deploy"], {
    cwd: path.join(import.meta.dirname, "../.."),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: "pipe",
  });

  return async () => {
    if (fixed) return;
    const done = adminClient(url.toString());
    await done.connect();
    await done.query(`drop database if exists "${dbName}" with (force)`);
    await done.end();
  };
}
