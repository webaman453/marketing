import { ConnectorError } from "@ashniva/connectors";
import { prisma, type PlatformConnection } from "@ashniva/db";
import { connectors } from "./connectors";
import { decryptSecret, encryptSecret } from "./crypto";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Returns a usable access token for the connection, refreshing it first when
 * it is about to expire. Marks the connection EXPIRED if that is impossible.
 */
export async function getAccessToken(connection: PlatformConnection): Promise<string> {
  if (connection.mode === "DEMO") return "sample";
  if (!connection.accessTokenEnc) throw new ConnectorError("AUTH_EXPIRED", "Connection has no access token.");

  const expiresSoon =
    connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!expiresSoon) return decryptSecret(connection.accessTokenEnc);

  const refreshToken = connection.refreshTokenEnc ? decryptSecret(connection.refreshTokenEnc) : null;
  const refreshed = refreshToken
    ? await connectors().get(connection.platform).refreshTokens(refreshToken)
    : null;

  if (!refreshed) {
    await prisma.platformConnection.update({
      where: { id: connection.id },
      data: { status: "EXPIRED", lastSyncError: "Access expired. Reconnect this account to resume syncing." },
    });
    throw new ConnectorError("AUTH_EXPIRED", "Access token expired and cannot be refreshed.");
  }

  await prisma.platformConnection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encryptSecret(refreshed.accessToken),
      // Google only returns a new refresh token occasionally; keep the old one otherwise.
      refreshTokenEnc: refreshed.refreshToken ? encryptSecret(refreshed.refreshToken) : connection.refreshTokenEnc,
      tokenExpiresAt: refreshed.expiresAt ?? null,
      status: "ACTIVE",
    },
  });
  return refreshed.accessToken;
}
