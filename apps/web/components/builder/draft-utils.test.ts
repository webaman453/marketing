import { BUILDER_SPECS, newDraft, type BuilderDraft, type BuilderIssue } from "@ashniva/shared";
import { describe, expect, it } from "vitest";
import { makeCreative } from "@/test-utils/fixtures";
import { adContextOf, applyAutoSelect, identityName, issuesFor, nodeOrder, previewDataFor, sameSelection } from "./draft-utils";

const spec = BUILDER_SPECS.META;
const draft = (): BuilderDraft => newDraft(spec, "acc_1", { objective: "OUTCOME_TRAFFIC" }, "Festive");

describe("applyAutoSelect", () => {
  it("pre-picks the first Page and Instagram account, like Ads Manager", () => {
    const d = draft();
    const out = applyAutoSelect(spec, d, {
      pages: [
        { id: "p1", name: "Acme" },
        { id: "p2", name: "Other" },
      ],
      instagramAccounts: [{ id: "ig1", name: "@acme" }],
    });
    const ad = out.adGroups[0]!.ads[0]!.values;
    expect(ad.pageId).toBe("p1");
    expect(ad.instagramId).toBe("ig1");
    // The draft itself isn't mutated.
    expect(d.adGroups[0]!.ads[0]!.values.pageId).toBe("");
  });

  it("keeps a choice that's already made and does nothing without options", () => {
    const d = draft();
    d.adGroups[0]!.ads[0]!.values.pageId = "p2";
    const out = applyAutoSelect(spec, d, { pages: [{ id: "p1", name: "Acme" }] });
    expect(out.adGroups[0]!.ads[0]!.values.pageId).toBe("p2");
    expect(applyAutoSelect(spec, draft(), {}).adGroups[0]!.ads[0]!.values.pageId).toBe("");
  });

  it("skips hidden account fields (no pixel for a traffic objective)", () => {
    const out = applyAutoSelect(spec, draft(), { pixels: [{ id: "px", name: "Pixel" }] });
    expect(out.adGroups[0]!.values.pixelId).not.toBe("px");
  });
});

describe("selection helpers", () => {
  it("orders nodes campaign → ad group → ads", () => {
    const d = draft();
    const g = d.adGroups[0]!;
    expect(nodeOrder(d)).toEqual([{ level: "campaign" }, { level: "adGroup", key: g.key }, { level: "ad", groupKey: g.key, key: g.ads[0]!.key }]);
  });

  it("compares selections", () => {
    expect(sameSelection({ level: "campaign" }, { level: "campaign" })).toBe(true);
    expect(sameSelection({ level: "adGroup", key: "a" }, { level: "adGroup", key: "a" })).toBe(true);
    expect(sameSelection({ level: "adGroup", key: "a" }, { level: "adGroup", key: "b" })).toBe(false);
    expect(sameSelection({ level: "adGroup", key: "a" }, { level: "campaign" })).toBe(false);
  });

  it("groups issues by node; setup issues count on the campaign", () => {
    const issues: BuilderIssue[] = [
      { level: "setup", message: "Choose objective." },
      { level: "campaign", field: "name", message: "Name" },
      { level: "adGroup", nodeKey: "g1", message: "G1" },
      { level: "ad", nodeKey: "a1", message: "A1" },
      { level: "ad", nodeKey: "a2", message: "A2" },
    ];
    expect(issuesFor(issues, { level: "campaign" }).map((i) => i.message)).toEqual(["Choose objective.", "Name"]);
    expect(issuesFor(issues, { level: "adGroup", key: "g1" }).map((i) => i.message)).toEqual(["G1"]);
    expect(issuesFor(issues, { level: "ad", groupKey: "g1", key: "a2" }).map((i) => i.message)).toEqual(["A2"]);
  });
});

describe("preview helpers", () => {
  it("names the ad after the chosen Page, without '(sample)'", () => {
    expect(identityName({ pageId: "p1" }, { pages: [{ id: "p1", name: "Acme Store (sample data)" }] }, "Fallback")).toBe("Acme Store");
    expect(identityName({ pageId: "zzz" }, { pages: [] }, "Fallback")).toBe("Fallback");
    expect(identityName({ organizationId: "o" }, { organizations: [{ id: "o", name: "Org" }] }, "F")).toBe("Org");
  });

  it("builds preview data with creative media for the selected ad", () => {
    const d = draft();
    const cr = makeCreative({ id: "cr1" });
    d.adGroups[0]!.ads[0]!.values.media = ["cr1"];
    const g = d.adGroups[0]!;
    const { data, ctx } = previewDataFor(spec, d, { level: "ad", groupKey: g.key, key: g.ads[0]!.key }, [cr], {}, "Workspace");
    expect(data.platform).toBe("META");
    expect(data.media.cr1).toMatchObject({ url: cr.url, type: "IMAGE", name: cr.name });
    expect(data.identity.name).toBe("Workspace");
    expect(ctx.adGroup).toBe(g.values);
    // From the campaign node, the first ad group and ad are previewed.
    expect(previewDataFor(spec, d, { level: "campaign" }, [], {}, "W").ctx.ad).toBe(g.ads[0]!.values);
  });

  it("summarises the ad's text for AI context, skipping ids, URLs and the format", () => {
    expect(
      adContextOf({ headline: "Big sale", primaryTexts: ["One", { text: "Two", pin: null }, ""], pageId: "123", url: "https://x.com", cta: "SHOP_NOW", format: "SINGLE", count: 3 }),
    ).toBe("headline: Big sale\nprimaryTexts: One | Two");
  });
});
