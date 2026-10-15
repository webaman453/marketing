import { randomBytes } from "node:crypto";

export function slugify(input: string) {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 40) || "workspace"
  );
}

/** Slug guaranteed unique via the `exists` check, appending a short suffix on collision. */
export async function uniqueSlug(input: string, exists: (slug: string) => Promise<boolean>) {
  const base = slugify(input);
  if (!(await exists(base))) return base;
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${randomBytes(2).toString("hex")}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${base}-${randomBytes(4).toString("hex")}`;
}
