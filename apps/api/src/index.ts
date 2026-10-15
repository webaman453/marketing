import { loadEnv } from "@ashniva/core";

loadEnv();

const { config } = await import("./config");
const { createApp } = await import("./app");
const { logger } = await import("./lib/logger");
const { prisma } = await import("@ashniva/db");
const { loadPlatformSettings } = await import("@ashniva/core");

// Keys and prices saved in the admin console override .env from the first request on.
await loadPlatformSettings(true).catch((err: unknown) => logger.error({ err }, "Couldn't load platform settings; using .env only"));

const port = config().API_PORT;
const server = createApp().listen(port, () => {
  logger.info(`API ready on http://localhost:${port}`);
});

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
