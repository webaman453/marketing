import { ConnectorError, type AdPlatformConnector } from "@ashniva/connectors";
import type { Platform } from "@ashniva/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../../test/helpers/db";
import { createOrg, createUser } from "../../../test/helpers/factories";
import { connectors } from "../src/connectors";
import { decryptSecret, encryptSecret } from "../src/crypto";
import { encryptConnectionCredentials, getConnectorAuth } from "../src/tokens";

/** Faster than resetDb(): every tenant row cascades from organizations or users. */
const reset = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.platformSetting.deleteMany()]);

const refreshTokens = vi.fn();
let orgId: string;

beforeEach(async () => {
  await reset();
  refreshTokens.mockReset();
  // A fake connector: no platform HTTP ever leaves the machine.
  vi.spyOn(connectors(), "get").mockImplementation(((platform: Platform) => ({ platform, refreshTokens }) as unknown as AdPlatformConnector) as never);
  ({ org: { id: orgId } } = await createOrg(await createUser()));
});

afterEach(() => vi.restoreAllMocks());

let n = 0;
function connection(data: Partial<Parameters<typeof prisma.platformConnection.create>[0]["data"]> = {}) {
  return prisma.platformConnection.create({
    data: {
      orgId,
      platform: "GOOGLE",
      mode: "LIVE",
      externalUserId: `ext-${n++}`,
      accessTokenEnc: encryptSecret("old-access"),
      refreshTokenEnc: encryptSecret("old-refresh"),
      status: "ACTIVE",
      ...data,
    } as never,
  });
}

const reload = (id: string) => prisma.platformConnection.findUniqueOrThrow({ where: { id } });
const soon = () => new Date(Date.now() + 60_000);

describe("getConnectorAuth", () => {
  it("sample connections never need a token", async () => {
    const c = await connection({ mode: "DEMO", accessTokenEnc: null });
    expect(await getConnectorAuth(c)).toEqual({ accessToken: "sample" });
  });

  it("returns the stored token while it is valid for more than 5 minutes", async () => {
    const c = await connection({ tokenExpiresAt: new Date(Date.now() + 3600_000) });
    expect(await getConnectorAuth(c)).toEqual({ accessToken: "old-access", credentials: null });
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it("treats a token without an expiry as valid", async () => {
    const c = await connection({ tokenExpiresAt: null });
    expect((await getConnectorAuth(c)).accessToken).toBe("old-access");
  });

  it("refreshes a token that expires soon and stores the new tokens", async () => {
    const expiresAt = new Date(Date.now() + 3600_000);
    refreshTokens.mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh", expiresAt });
    const c = await connection({ tokenExpiresAt: soon(), status: "ERROR" });
    expect(await getConnectorAuth(c)).toEqual({ accessToken: "new-access", credentials: null });
    expect(refreshTokens).toHaveBeenCalledWith("old-refresh", null);
    const after = await reload(c.id);
    expect(decryptSecret(after.accessTokenEnc!)).toBe("new-access");
    expect(decryptSecret(after.refreshTokenEnc!)).toBe("new-refresh");
    expect(after.tokenExpiresAt).toEqual(expiresAt);
    expect(after.status).toBe("ACTIVE");
  });

  it("refreshes an already expired token", async () => {
    refreshTokens.mockResolvedValue({ accessToken: "new-access" });
    const c = await connection({ tokenExpiresAt: new Date(Date.now() - 3600_000) });
    expect((await getConnectorAuth(c)).accessToken).toBe("new-access");
  });

  it("keeps the old refresh token when the platform returns none", async () => {
    refreshTokens.mockResolvedValue({ accessToken: "new-access", refreshToken: undefined, expiresAt: undefined });
    const c = await connection({ tokenExpiresAt: soon() });
    await getConnectorAuth(c);
    const after = await reload(c.id);
    expect(after.refreshTokenEnc).toBe(c.refreshTokenEnc);
    expect(decryptSecret(after.refreshTokenEnc!)).toBe("old-refresh");
    expect(after.tokenExpiresAt).toBeNull();
  });

  it("marks the connection EXPIRED when there is no refresh token", async () => {
    const c = await connection({ tokenExpiresAt: soon(), refreshTokenEnc: null });
    await expect(getConnectorAuth(c)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(await reload(c.id)).toMatchObject({ status: "EXPIRED", lastSyncError: "Access expired. Reconnect this account to resume syncing." });
  });

  it("marks the connection EXPIRED when the platform can't refresh", async () => {
    refreshTokens.mockResolvedValue(null);
    const c = await connection({ tokenExpiresAt: soon() });
    await expect(getConnectorAuth(c)).rejects.toBeInstanceOf(ConnectorError);
    expect((await reload(c.id)).status).toBe("EXPIRED");
  });

  it("marks the connection EXPIRED when the platform rejects the refresh token", async () => {
    refreshTokens.mockRejectedValue(new ConnectorError("AUTH_EXPIRED", "invalid_grant"));
    const c = await connection({ tokenExpiresAt: soon() });
    await expect(getConnectorAuth(c)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect((await reload(c.id)).status).toBe("EXPIRED");
  });

  it("fails without an access token", async () => {
    const c = await connection({ accessTokenEnc: null });
    await expect(getConnectorAuth(c)).rejects.toMatchObject({ code: "AUTH_EXPIRED", message: "Connection has no access token." });
  });

  describe("key-based platforms", () => {
    it("passes the organization's own keys", async () => {
      const c = await connection({ platform: "OUTBRAIN", refreshTokenEnc: null, credentialsEnc: encryptConnectionCredentials("OUTBRAIN", { apiToken: "org-key" }) });
      expect(await getConnectorAuth(c)).toEqual({ accessToken: "old-access", credentials: { apiToken: "org-key" } });
    });

    it("uses the operator's keys on the operator's own connections", async () => {
      const c = await connection({ platform: "OUTBRAIN", refreshTokenEnc: null, credentialsEnc: encryptConnectionCredentials("OUTBRAIN", null) });
      expect(await getConnectorAuth(c)).toEqual({ accessToken: "old-access", credentials: null });
    });

    it("forces a reconnect when no keys are stored", async () => {
      const c = await connection({ platform: "OUTBRAIN", refreshTokenEnc: null, credentialsEnc: null });
      await expect(getConnectorAuth(c)).rejects.toMatchObject({ code: "AUTH_EXPIRED", message: "Reconnect Outbrain with your organization's own API keys." });
      expect(await reload(c.id)).toMatchObject({ status: "EXPIRED", lastSyncError: "Reconnect Outbrain with your organization's own API keys." });
    });

    it("passes the keys to refreshTokens", async () => {
      refreshTokens.mockResolvedValue({ accessToken: "fresh" });
      const c = await connection({ platform: "OUTBRAIN", tokenExpiresAt: soon(), credentialsEnc: encryptConnectionCredentials("OUTBRAIN", { apiToken: "k" }) });
      await getConnectorAuth(c);
      expect(refreshTokens).toHaveBeenCalledWith("old-refresh", { apiToken: "k" });
    });
  });
});

describe("encryptConnectionCredentials", () => {
  it("encrypts own keys, marks operator connections, and stores nothing for OAuth platforms", () => {
    expect(JSON.parse(decryptSecret(encryptConnectionCredentials("OUTBRAIN", { apiToken: "x" })!))).toEqual({ apiToken: "x" });
    expect(JSON.parse(decryptSecret(encryptConnectionCredentials("OUTBRAIN", null)!))).toEqual({ operatorKeys: "true" });
    expect(encryptConnectionCredentials("META", null)).toBeNull();
    expect(encryptConnectionCredentials("META", { a: "b" })).not.toBeNull();
  });
});
