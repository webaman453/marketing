import { imageSize } from "image-size";
import multer from "multer";
import { badRequest } from "./errors";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

/** In-memory multipart parser; files go straight to object storage afterwards. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 10 },
});

/** Logos are small: the request is cut off at 2 MB instead of buffering a large file. */
export const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

/**
 * Reads a video's display size from the first video track header ("tkhd") of an
 * MP4/MOV file. Returns nulls for other containers.
 */
export function videoSize(buf: Buffer): { width: number | null; height: number | null } {
  const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts"]);
  const walk = (start: number, end: number): { width: number; height: number } | null => {
    let pos = start;
    while (pos + 8 <= end) {
      let size = buf.readUInt32BE(pos);
      const type = buf.toString("latin1", pos + 4, pos + 8);
      let header = 8;
      if (size === 1 && pos + 16 <= end) {
        size = Number(buf.readBigUInt64BE(pos + 8));
        header = 16;
      } else if (size === 0) size = end - pos;
      if (size < header || pos + size > end) return null;
      if (type === "tkhd") {
        const version = buf[pos + header]!;
        // width/height are the last 8 bytes of tkhd, as 16.16 fixed point
        const w = buf.readUInt32BE(pos + size - 8) / 65536;
        const h = buf.readUInt32BE(pos + size - 4) / 65536;
        if (w > 0 && h > 0 && version <= 1) return { width: Math.round(w), height: Math.round(h) };
      } else if (CONTAINERS.has(type)) {
        const hit = walk(pos + header, pos + size);
        if (hit) return hit;
      }
      pos += size;
    }
    return null;
  };
  try {
    return walk(0, buf.length) ?? { width: null, height: null };
  } catch {
    return { width: null, height: null };
  }
}

/** True when the bytes are really a PNG or JPEG, whatever the browser said. */
export function isPngOrJpeg(buf: Buffer) {
  try {
    const t = imageSize(buf).type;
    return t === "png" || t === "jpg";
  } catch {
    return false;
  }
}

/** Validates a creative upload and reads image dimensions. */
export function inspectFile(file: Express.Multer.File) {
  const isImage = IMAGE_TYPES.includes(file.mimetype);
  const isVideo = VIDEO_TYPES.includes(file.mimetype);
  if (!isImage && !isVideo) throw badRequest(`${file.originalname}: only PNG, JPG, WebP, GIF, MP4, MOV or WebM files are supported.`);
  if (isImage && file.size > MAX_IMAGE_BYTES) throw badRequest(`${file.originalname}: images must be under 30 MB.`);

  let width: number | null = null;
  let height: number | null = null;
  if (isImage) {
    try {
      const dim = imageSize(file.buffer);
      width = dim.width ?? null;
      height = dim.height ?? null;
    } catch {
      throw badRequest(`${file.originalname} doesn't look like a valid image.`);
    }
  } else if (file.mimetype === "video/mp4" || file.mimetype === "video/quicktime") {
    ({ width, height } = videoSize(file.buffer));
  }
  return { type: isImage ? ("IMAGE" as const) : ("VIDEO" as const), width, height };
}
