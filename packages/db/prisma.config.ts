import path from "node:path";
import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

config({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "pnpm --filter @ashniva/core seed",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
