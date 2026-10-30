import { prisma } from "@ashniva/db";

let tables: string[] | null = null;
let fastAllowed = true;

/**
 * Empties every table (keeps the migrations table). Call in beforeEach of integration tests.
 * Uses DELETE with foreign-key triggers off in one statement (~0.1 s); TRUNCATE takes 1–60 s
 * on a busy machine. Falls back to TRUNCATE when the role may not set session_replication_role
 * (it needs a superuser, which the local and CI test roles are).
 */
export async function resetDb() {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("resetDb only runs against a test database");
  if (fastAllowed) {
    try {
      await prisma.$executeRawUnsafe(`DO $$ DECLARE r record; BEGIN
        SET LOCAL session_replication_role = replica;
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' LOOP
          EXECUTE 'DELETE FROM ' || quote_ident(r.tablename);
        END LOOP;
      END $$;`);
      return;
    } catch {
      fastAllowed = false;
    }
  }
  tables ??= (
    await prisma.$queryRaw<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations'`
  ).map((t) => `"${t.tablename}"`);
  if (tables.length) await prisma.$executeRawUnsafe(`truncate table ${tables.join(", ")} restart identity cascade`);
}

export { prisma };
