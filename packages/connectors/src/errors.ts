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
