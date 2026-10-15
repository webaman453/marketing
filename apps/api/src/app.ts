import { loadPlatformSettings } from "@ashniva/core";
import { prisma } from "@ashniva/db";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { config } from "./config";
import { logger } from "./lib/logger";
import { requireAuth, requireSuperAdmin } from "./middleware/auth";
import { adminRouter } from "./modules/admin.routes";
import { billingWebhookRouter } from "./modules/billing.routes";
import { filesRouter } from "./modules/files.routes";
import { notificationsRouter } from "./modules/notifications.routes";
import { publicApiRouter } from "./modules/public-api.routes";
import { publicReportsRouter } from "./modules/reports.routes";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { authRouter } from "./modules/auth.routes";
import { catalogRouter } from "./modules/catalog.routes";
import { oauthRouter } from "./modules/integrations.routes";
import { orgsRouter } from "./modules/orgs.routes";
import { workspacesRouter } from "./modules/workspaces.routes";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config().TRUST_PROXY);

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: config().WEB_URL, credentials: true }));
  // Picks up keys and prices the owner changed in the admin console (cached for a few seconds).
  app.use((_req, _res, next) => {
    loadPlatformSettings().then(() => next(), () => next());
  });
  // The billing webhook needs the raw body for its signature, so it's mounted before the JSON parser.
  app.use("/api/billing/webhook", billingWebhookRouter);
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === "/api/health" },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
      serializers: { req: (req) => ({ method: req.method, url: req.url }), res: (res) => ({ status: res.statusCode }) },
    }),
  );

  app.get("/api/health", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  app.use("/api/catalog", catalogRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/oauth", oauthRouter);
  app.use("/api/files", filesRouter);
  app.use("/api/public/reports", publicReportsRouter);
  app.use("/api/v1", publicApiRouter);
  app.use("/api/notifications", requireAuth, notificationsRouter);
  app.use("/api/admin", requireAuth, requireSuperAdmin, adminRouter);
  app.use("/api/orgs", requireAuth, orgsRouter);
  app.use("/api/workspaces/:workspaceId", requireAuth, workspacesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
