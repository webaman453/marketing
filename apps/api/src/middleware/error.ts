import { isConnectorError } from "@ashniva/connectors";
import { DraftInvalidError, EntitlementError } from "@ashniva/core";
import multer from "multer";
import { Prisma } from "@ashniva/db";
import type { ApiErrorBody } from "@ashniva/shared";
import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/errors";
import { logger } from "../lib/logger";

const CONNECTOR_STATUS: Record<string, number> = {
  NOT_CONFIGURED: 503,
  AUTH_EXPIRED: 409,
  PERMISSION_DENIED: 403,
  RATE_LIMITED: 429,
  INVALID_REQUEST: 422,
  UNSUPPORTED: 422,
  PLATFORM_ERROR: 502,
};

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } } satisfies ApiErrorBody);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof EntitlementError) {
    res.status(402).json({ error: { code: err.code, message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof DraftInvalidError) {
    res.status(422).json({ error: { code: "DRAFT_INVALID", message: err.message, issues: err.issues } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "That file is too large." : err.message;
    res.status(413).json({ error: { code: "UPLOAD_ERROR", message } } satisfies ApiErrorBody);
    return;
  }
  if (isConnectorError(err)) {
    logger.warn({ code: err.code, details: err.details }, `Connector error: ${err.message}`);
    res.status(CONNECTOR_STATUS[err.code] ?? 502).json({
      error: { code: `PLATFORM_${err.code}`, message: err.message },
    } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    res.status(409).json({ error: { code: "CONFLICT", message: "That already exists." } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: { code: "BAD_JSON", message: "Malformed JSON body." } } satisfies ApiErrorBody);
    return;
  }
  logger.error({ err, path: req.path }, "Unhandled error");
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } } satisfies ApiErrorBody);
}
