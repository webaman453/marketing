import { addDays } from "@ashniva/shared";
import { dayIn } from "../builder-values";
import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS, DemoConnector, generateDemoLeadsFor, generateDemoMetrics, generateDemoStructure } from "./index";
import { DEMO_LEAD_DAYS } from "./leads";

const META = DEMO_ACCOUNTS.META!.externalId;
const auth = { accessToken: "sample" };

describe("sample leads", () => {
  const now = new Date();
  const leads = generateDemoLeadsFor(META, { since: null, now });

  it("are deterministic and have unique ids", () => {
    expect(leads.length).toBeGreaterThan(300);
    expect(generateDemoLeadsFor(META, { since: null, now })).toEqual(leads);
    expect(new Set(leads.map((l) => l.externalId)).size).toBe(leads.length);
  });

  it("belong to the sample lead-gen campaign's ads and match their conversions", () => {
    const structure = generateDemoStructure(META);
    const adIds = new Set(structure.ads.map((a) => a.externalId));
    const leadCampaign = structure.campaigns.find((c) => c.objective === "OUTCOME_LEADS")!;
    for (const l of leads) {
      expect(adIds.has(l.externalAdId!)).toBe(true);
      expect(l.externalCampaignId).toBe(leadCampaign.externalId);
      expect(l.campaignName).toBe(leadCampaign.name);
    }
    // The sample account's day (Asia/Kolkata), which metric dates and lead windows use.
    const today = dayIn(now, DEMO_ACCOUNTS.META!.timezone);
    const conversions = generateDemoMetrics(META, { from: addDays(today, -(DEMO_LEAD_DAYS - 1)), to: addDays(today, -1) })
      .filter((r) => r.level === "CAMPAIGN" && r.externalId === leadCampaign.externalId)
      .reduce((a, r) => a + r.conversions, 0);
    const before = leads.filter((l) => l.createdTime < new Date(`${today}T00:00:00+05:30`)).length;
    expect(Math.abs(before - conversions) / conversions).toBeLessThan(0.15);
  });

  it("look like real but clearly fake Meta form leads, spread over the last 30 days", () => {
    for (const l of leads) {
      expect(["fb", "ig"]).toContain(l.source);
      expect(l.fields.email![0]).toMatch(/@example\.com$/);
      expect(l.fields.phone_number![0]).toMatch(/^\+91 98765 \d{5}$/);
      expect(l.fields.full_name![0]).toMatch(/^\S+ \S+$/);
      expect(l.fields.city).toHaveLength(1);
      expect(l.createdTime.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(now.getTime() - l.createdTime.getTime()).toBeLessThan((DEMO_LEAD_DAYS + 1) * 86_400_000);
    }
    expect(new Set(leads.map((l) => l.source))).toEqual(new Set(["fb", "ig"]));
    // More leads in the evening (IST) than in the small hours.
    const istHour = (d: Date) => new Date(d.getTime() + 330 * 60_000).getUTCHours();
    const at = (h: number) => leads.filter((l) => istHour(l.createdTime) === h).length;
    expect(at(20)).toBeGreaterThan(at(3) * 3);
  });

  it("fetchLeads honours `since`, and platforms without lead-gen campaigns have none", async () => {
    const meta = new DemoConnector("META");
    const since = new Date(Date.now() - 3 * 86_400_000);
    const recent = await meta.fetchLeads(auth, { since });
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.every((l) => l.createdTime > since)).toBe(true);
    expect((await new DemoConnector("LINKEDIN").fetchLeads(auth, { since: null })).length).toBeGreaterThan(0);
    expect(await new DemoConnector("GOOGLE").fetchLeads(auth, { since: null })).toEqual([]);
  });
});
