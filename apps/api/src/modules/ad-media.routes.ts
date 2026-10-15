import { adWithConnection, getAdMedia } from "@ashniva/core";
import { prisma } from "@ashniva/db";
import { Router } from "express";
import { Readable } from "node:stream";
import { badRequest, notFound } from "../lib/errors";
import { workspaceAccountIds } from "./analytics.service";

/** Mounted under /api/workspaces/:workspaceId after loadWorkspace. */
export const adMediaRouter = Router({ mergeParams: true });

/** Only these CDNs may be fetched for download: the URL comes from the platform, but never trust it blindly. */
const ALLOWED_HOSTS = [/\.fbcdn\.net$/i, /\.facebook\.com$/i, /\.fbsbx\.com$/i, /\.cdninstagram\.com$/i];

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

const safeName = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "ad";

async function findAd(req: { params: Record<string, string | string[] | undefined>; workspace?: { id: string } }) {
  const accountIds = await workspaceAccountIds(req.workspace!.id);
  const ad = await prisma.ad.findFirst({
    where: { id: req.params.adId as string, adAccountId: { in: accountIds } },
    include: adWithConnection,
  });
  if (!ad) throw notFound("Ad");
  return ad;
}

adMediaRouter.get("/ads/:adId/media", async (req, res) => {
  const ad = await findAd(req);
  const media = await getAdMedia(ad);
  res.json(media);
});

adMediaRouter.get("/ads/:adId/media/:index/download", async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) throw badRequest("Invalid file number.");
  const ad = await findAd(req);
  const media = await getAdMedia(ad);
  const item = media.items[index];
  if (!item?.url) throw notFound("Media file");

  const target = new URL(item.url);
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.some((re) => re.test(target.hostname))) {
    throw badRequest("This file can't be downloaded from here.");
  }

  const upstream = await fetch(target, { redirect: "error" });
  if (!upstream.ok || !upstream.body) throw notFound("Media file");

  const type = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const ext = EXTENSIONS[type] ?? (item.type === "VIDEO" ? "mp4" : "jpg");
  const suffix = media.items.length > 1 ? `-${index + 1}` : "";
  res.setHeader("Content-Type", type || "application/octet-stream");
  const length = upstream.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName(ad.name)}${suffix}.${ext}"`);
  res.setHeader("Cache-Control", "private, no-store");
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
});
