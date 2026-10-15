import { getFile } from "@ashniva/core";
import { Router } from "express";
import { notFound } from "../lib/errors";

/**
 * Serves stored creatives and logos from local storage (development, or when
 * no CDN is configured). Keys are long random strings, so URLs are unguessable.
 */
export const filesRouter = Router();

filesRouter.get("/{*key}", async (req, res) => {
  const parts = (req.params as { key?: string[] }).key ?? [];
  const file = await getFile(parts.join("/"));
  if (!file) throw notFound("File");
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.send(file.data);
});
