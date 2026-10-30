export type ConnectorErrorCode =
  | "NOT_CONFIGURED"
  | "AUTH_EXPIRED"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "UNSUPPORTED"
  | "PLATFORM_ERROR";

/** Normalized error thrown by every connector so callers can react uniformly. */
export class ConnectorError extends Error {
  constructor(
    public readonly code: ConnectorErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ConnectorError";
  }

  /** Whether retrying later might succeed. */
  get retryable() {
    return this.code === "RATE_LIMITED" || this.code === "PLATFORM_ERROR";
  }
}

export const isConnectorError = (e: unknown): e is ConnectorError => e instanceof ConnectorError;

/**
 * Catch handler for best-effort report calls: a 4xx about the report itself
 * (a metric or breakdown the account cannot run) gives no rows, while expired
 * logins, missing permissions, rate limits and outages still throw so the sync
 * records them instead of quietly saving nothing.
 */
export function noRowsUnlessFatal<T>(err: unknown): T[] {
  if (isConnectorError(err) && (err.code === "INVALID_REQUEST" || err.code === "UNSUPPORTED")) return [];
  throw err;
}

/**
 * Catch handler for a refresh-token grant. RFC 6749 §5.2: an expired or revoked refresh token is
 * HTTP 400 `invalid_grant`, which codeFromStatus reads as INVALID_REQUEST. That is an expired login,
 * so it becomes AUTH_EXPIRED and the connection asks to reconnect instead of retrying. Anything
 * else is rethrown as is. Use only on refresh calls: on a code exchange invalid_grant is a bad code.
 */
export function expiredGrant(err: unknown): never {
  if (isConnectorError(err) && err.code !== "AUTH_EXPIRED" && isInvalidGrant(err.details)) {
    throw new ConnectorError("AUTH_EXPIRED", err.message, err.details);
  }
  throw err;
}

function isInvalidGrant(body: unknown) {
  const b = body as { error?: unknown; error_code?: unknown } | null;
  return typeof b?.error === "string" && b.error.toLowerCase() === "invalid_grant";
}
