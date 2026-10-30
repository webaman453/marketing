import { PRICING, applyCatalog, defaultCatalog } from "@ashniva/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../../test/helpers/db";
import { addMember, createOrg, createUser } from "../../../test/helpers/factories";
import { adjustAiTokens, assertAiTokens, chargeAiUsage, creditAiOrder, freeAiTokens } from "../src/ai-tokens";

/** Faster than resetDb(): every tenant row cascades from organizations or users. */
const resetDb = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.platformSetting.deleteMany()]);

beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterAll(() => applyCatalog(defaultCatalog()));

async function orgWith(balance: number) {
  const owner = await createUser();
  const { org, workspace } = await createOrg(owner, { aiTokenBalance: balance });
  return { owner, org, workspace };
}

const balanceOf = async (orgId: string) => (await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).aiTokenBalance;

describe("freeAiTokens", () => {
  it("follows the price list", () => {
    applyCatalog(defaultCatalog());
    expect(freeAiTokens()).toBe(PRICING.aiFreeTokens);
    expect(freeAiTokens()).toBe(100_000);
    applyCatalog({ ...defaultCatalog(), aiFreeTokens: 2500 });
    expect(freeAiTokens()).toBe(2500);
    applyCatalog(defaultCatalog());
  });
});

describe("assertAiTokens", () => {
  it("returns the balance when it covers the minimum", async () => {
    const { org } = await orgWith(PRICING.aiMinBalance);
    expect(await assertAiTokens(org.id)).toBe(PRICING.aiMinBalance);
  });

  it("asks to buy tokens when the balance is below the minimum", async () => {
    const { org } = await orgWith(PRICING.aiMinBalance - 1);
    await expect(assertAiTokens(org.id)).rejects.toMatchObject({ code: "AI_TOKENS_EXHAUSTED", message: expect.stringContaining("too low") });
  });

  it("says the tokens are used up at zero or below", async () => {
    const { org } = await orgWith(0);
    await expect(assertAiTokens(org.id)).rejects.toMatchObject({ code: "AI_TOKENS_EXHAUSTED", message: expect.stringContaining("used all") });
    await prisma.organization.update({ where: { id: org.id }, data: { aiTokenBalance: -40 } });
    await expect(assertAiTokens(org.id)).rejects.toMatchObject({ message: expect.stringContaining("used all") });
  });

  it("uses the minimum from the price list", async () => {
    const { org } = await orgWith(600);
    applyCatalog({ ...defaultCatalog(), aiMinBalance: 500 });
    try {
      expect(await assertAiTokens(org.id)).toBe(600);
    } finally {
      applyCatalog(defaultCatalog());
    }
  });
});

describe("chargeAiUsage", () => {
  it("deducts input + output tokens and records the usage", async () => {
    const { org, owner, workspace } = await orgWith(50_000);
    const balance = await chargeAiUsage({ orgId: org.id, feature: "builder.fill", model: "m1", inputTokens: 1200, outputTokens: 300.6, userId: owner.id, workspaceId: workspace.id });
    expect(balance).toBe(50_000 - 1501);
    expect(await balanceOf(org.id)).toBe(48_499);
    const [row] = await prisma.aiTokenLedger.findMany({ where: { orgId: org.id } });
    expect(row).toMatchObject({ type: "USAGE", tokens: -1501, balanceAfter: 48_499, feature: "builder.fill", model: "m1", inputTokens: 1200, userId: owner.id, workspaceId: workspace.id });
  });

  it("records nothing for a call that used no tokens", async () => {
    const { org } = await orgWith(50_000);
    expect(await chargeAiUsage({ orgId: org.id, feature: "builder.fill", model: "m", inputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(await chargeAiUsage({ orgId: org.id, feature: "builder.fill", model: "m", inputTokens: -5, outputTokens: 2 })).toBeNull();
    expect(await prisma.aiTokenLedger.count()).toBe(0);
    expect(await balanceOf(org.id)).toBe(50_000);
  });

  it("may dip below zero on the last call", async () => {
    const { org } = await orgWith(100);
    expect(await chargeAiUsage({ orgId: org.id, feature: "builder.fill", model: "m", inputTokens: 300, outputTokens: 0 })).toBe(-200);
  });

  it("keeps a consistent running balance under concurrent calls", async () => {
    const { org } = await orgWith(100_000);
    await Promise.all(Array.from({ length: 10 }, () => chargeAiUsage({ orgId: org.id, feature: "builder.fill", model: "m", inputTokens: 100, outputTokens: 0 })));
    expect(await balanceOf(org.id)).toBe(99_000);
    const rows = await prisma.aiTokenLedger.findMany({ where: { orgId: org.id }, orderBy: { balanceAfter: "desc" } });
    expect(rows.map((r) => r.balanceAfter)).toEqual(Array.from({ length: 10 }, (_, i) => 99_900 - i * 100));
  });

  it("alerts owners and admins once, on the call that crosses the low-balance line", async () => {
    const { org, workspace } = await orgWith(12_000);
    const admin = await createUser();
    const analyst = await createUser();
    await addMember(org.id, admin, "ADMIN");
    await addMember(org.id, analyst, "ANALYST");

    await chargeAiUsage({ orgId: org.id, feature: "builder.fill", model: "m", inputTokens: 1000, outputTokens: 0 }); // 11,000
    expect(await prisma.notification.count()).toBe(0);
    await chargeAiUsage({ orgId: org.id, feature: "builder.fill", model: "m", inputTokens: 2000, outputTokens: 0 }); // 9,000
    const sent = await prisma.notification.findMany({ where: { type: "ai.low_balance" } });
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((n) => n.userId)).has(analyst.id)).toBe(false);
    expect(sent[0]!.title).toBe("AI tokens running low: 9,000 left");
    expect(sent[0]!.link).toBe(`/w/${workspace.id}/settings/ai`);

    await chargeAiUsage({ orgId: org.id, feature: "builder.fill", model: "m", inputTokens: 2000, outputTokens: 0 }); // 7,000
    expect(await prisma.notification.count()).toBe(2);
  });
});

describe("adjustAiTokens", () => {
  it("grants or removes tokens with a note", async () => {
    const { org, owner } = await orgWith(1000);
    expect(await adjustAiTokens(org.id, 5000.4, "Goodwill", owner.id)).toBe(6000);
    expect(await adjustAiTokens(org.id, -2500, "Correction", null)).toBe(3500);
    const rows = await prisma.aiTokenLedger.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.type, r.tokens, r.balanceAfter, r.note, r.userId])).toEqual([
      ["ADJUSTMENT", 5000, 6000, "Goodwill", owner.id],
      ["ADJUSTMENT", -2500, 3500, "Correction", null],
    ]);
  });
});

describe("creditAiOrder", () => {
  async function order(orgId: string, userId: string) {
    return prisma.aiTokenOrder.create({ data: { orgId, packId: "starter", tokens: 50_000, amount: 49_900, createdById: userId, providerOrderId: `order_${Math.random()}` } });
  }

  it("credits a paid order exactly once", async () => {
    const { org, owner } = await orgWith(1000);
    const o = await order(org.id, owner.id);
    expect(await creditAiOrder(o.id, "pay_1")).toBe(true);
    expect(await creditAiOrder(o.id, "pay_1")).toBe(false);
    expect(await balanceOf(org.id)).toBe(51_000);
    const paid = await prisma.aiTokenOrder.findUniqueOrThrow({ where: { id: o.id } });
    expect(paid).toMatchObject({ status: "PAID", paymentId: "pay_1" });
    expect(paid.paidAt).toBeInstanceOf(Date);
    const rows = await prisma.aiTokenLedger.findMany({ where: { orgId: org.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "PURCHASE", tokens: 50_000, balanceAfter: 51_000, orderId: o.id, userId: owner.id, note: "Token pack · ₹499" });
  });

  it("is idempotent under concurrent payment confirmations", async () => {
    const { org, owner } = await orgWith(0);
    const o = await order(org.id, owner.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => creditAiOrder(o.id, "pay_2").catch(() => false)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await balanceOf(org.id)).toBe(50_000);
    expect(await prisma.aiTokenLedger.count({ where: { orgId: org.id } })).toBe(1);
  });

  it("ignores unknown or failed orders", async () => {
    const { org, owner } = await orgWith(0);
    expect(await creditAiOrder("missing", "pay_3")).toBe(false);
    const o = await order(org.id, owner.id);
    await prisma.aiTokenOrder.update({ where: { id: o.id }, data: { status: "FAILED" } });
    expect(await creditAiOrder(o.id, "pay_4")).toBe(false);
    expect(await balanceOf(org.id)).toBe(0);
  });
});
