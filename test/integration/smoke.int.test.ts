import { beforeEach, describe, expect, it } from "vitest";
import { anon, as } from "../helpers/api";
import { resetDb } from "../helpers/db";
import { createOrg, createUser } from "../helpers/factories";

describe("test harness", () => {
  beforeEach(resetDb);

  it("serves the API against the test database", async () => {
    const res = await (await anon()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("signs a user in without /login", async () => {
    const user = await createUser({ name: "Asha" });
    await createOrg(user, { name: "Asha Media" });
    const res = await (await as(user)).get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
    expect(res.body.orgs.map((o: { name: string }) => o.name)).toEqual(["Asha Media"]);
  });

  it("rejects anonymous requests to private routes", async () => {
    const res = await (await anon()).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("keeps organizations apart", async () => {
    const a = await createUser();
    const b = await createUser();
    const { org: orgB } = await createOrg(b);
    await createOrg(a);
    const res = await (await as(a)).get(`/api/orgs/${orgB.id}/members`);
    expect([403, 404]).toContain(res.status);
  });
});
