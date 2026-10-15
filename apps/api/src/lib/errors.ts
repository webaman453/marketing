import type { ZodType } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: Record<string, string[]>) =>
  new HttpError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Please sign in to continue.") => new HttpError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You don't have permission to do that.") => new HttpError(403, "FORBIDDEN", message);
export const notFound = (what = "Resource") => new HttpError(404, "NOT_FOUND", `${what} not found.`);
export const conflict = (message: string) => new HttpError(409, "CONFLICT", message);

/** Validates input against a zod schema; throws a 422 with per-field messages on failure. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_";
    (details[key] ??= []).push(issue.message);
  }
  const first = result.error.issues[0];
  throw new HttpError(422, "VALIDATION_ERROR", first?.message ?? "Invalid input", details);
}
