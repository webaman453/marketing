import { afterAll } from "vitest";
import { applyTestEnv } from "./env";

applyTestEnv();

afterAll(async () => {
  const { prisma } = await import("@ashniva/db");
  await prisma.$disconnect();
});
