import { ConnectorError, type ConnectorAuth, type OAuthTokens, type PlatformCredentials } from "@ashniva/connectors";
import { prisma, type PlatformConnection } from "@ashniva/db";
import { PLATFORM_INFO, connectsWithCredentials } from "@ashniva/shared";
import { connectors } from "./connectors";
import { decryptSecret, encryptSecret } from "./crypto";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Stored instead of API keys on the operator's own connections to key-based platforms: use the keys from config. */
const OPERATOR_KEYS = "operatorKeys";

/** credentialsEnc for a new connection: the organization's own keys, the operator marker, or nothing (OAuth platforms). */
export function encryptConnectionCredentials(platform: PlatformConnection["platform"], credentials: PlatformCredentials | null) {
  if (credentials) return encryptSecret(JSON.stringify(credentials));
  return connectsWithCredentials(platform) ? encryptSecret(JSON.stringify({ [OPERATOR_KEYS]: "true" })) : null;
}

/**
 * Everything a connector call needs for this connection: a usable access token
 * (refreshed first when it is about to expire) and, on platforms without a
 * sign-in, the organization's own API keys. Marks the connection EXPIRED if
 * that is impossible.
 */
export async function getConnectorAuth(connection: PlatformConnection): Promise<ConnectorAuth> {
  if (connection.mode === "DEMO") return { accessToken: "sample" };
  const credentials = await connectionCredentials(connection);
  return { accessToken: await getAccessToken(connection, credentials), credentials };
}

/**
 * The organization's own API keys, or null for OAuth platforms and the
 * operator's own connections. A key-based connection with neither (one made
 * with the operator's keys before each organization brought its own) would see
 * every account the operator's keys reach, so it has to reconnect.
 */
async function connectionCredentials(connection: PlatformConnection): Promise<PlatformCredentials | null> {
  if (!connectsWithCredentials(connection.platform)) return null;
  const stored = connection.credentialsEnc ? (JSON.parse(decryptSecret(connection.credentialsEnc)) as PlatformCredentials) : null;
  if (stored?.[OPERATOR_KEYS]) return null;
  if (stored) return stored;
  const message = `Reconnect ${PLATFORM_INFO[connection.platform].name} with your organization's own API keys.`;
  await expire(connection, message);
  throw new ConnectorError("AUTH_EXPIRED", message);
}

async function getAccessToken(connection: PlatformConnection, credentials: PlatformCredentials | null): Promise<string> {
  if (!connection.accessTokenEnc) throw new ConnectorError("AUTH_EXPIRED", "Connection has no access token.");

  const expiresSoon =
    connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!expiresSoon) return decryptSecret(connection.accessTokenEnc);

  const refreshToken = connection.refreshTokenEnc ? decryptSecret(connection.refreshTokenEnc) : null;
  let refreshed: OAuthTokens | null = null;
  if (refreshToken) {
    try {
      refreshed = await connectors().get(connection.platform).refreshTokens(refreshToken, credentials);
    } catch (err) {
      // The platform rejected the refresh token (e.g. Google invalid_grant): no caller can use this connection
      // until it is reconnected. Transient failures (network, rate limits) leave it as it is.
      if (err instanceof ConnectorError && err.code === "AUTH_EXPIRED") {
        await expire(connection, "Access expired. Reconnect this account to resume syncing.");
      }
      throw err;
    }
  }

  if (!refreshed) {
    await expire(connection, "Access expired. Reconnect this account to resume syncing.");
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

async function expire(connection: PlatformConnection, message: string) {
  await prisma.platformConnection.update({
    where: { id: connection.id },
    data: { status: "EXPIRED", lastSyncError: message },
  });
}
