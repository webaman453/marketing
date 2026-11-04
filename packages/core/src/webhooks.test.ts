import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ashniva/db", () => ({ prisma: {} }));

const { WebhookUrlError, channelWants, genericBody, parseWhatsAppConfig, whatsappText, isPrivateAddress, signPayload, slackBody, validateWebhookUrl } = await import("./webhooks");

describe("isPrivateAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::5", "::ffff:10.0.0.1"])("blocks %s", (a) => {
    expect(isPrivateAddress(a)).toBe(true);
  });
  it.each(["8.8.8.8", "52.1.2.3", "172.32.0.1", "2606:4700::1111"])("allows %s", (a) => {
    expect(isPrivateAddress(a)).toBe(false);
  });
});

describe("validateWebhookUrl", () => {
  it("accepts a Slack incoming webhook and an https endpoint", () => {
    expect(validateWebhookUrl("https://hooks.slack.com/services/T0/B0/xyz", "SLACK").hostname).toBe("hooks.slack.com");
    expect(validateWebhookUrl("https://example.com/hook", "WEBHOOK").pathname).toBe("/hook");
  });

  it.each([
    ["http://example.com/hook", "WEBHOOK"],
    ["not a url", "WEBHOOK"],
    ["https://user:pw@example.com/x", "WEBHOOK"],
    ["https://localhost/x", "WEBHOOK"],
    ["https://127.0.0.1/x", "WEBHOOK"],
    ["https://169.254.169.254/latest/meta-data", "WEBHOOK"],
    ["https://[::1]/x", "WEBHOOK"],
    ["https://printer.local/x", "WEBHOOK"],
    ["https://example.com/services/T0/B0/x", "SLACK"],
  ] as const)("rejects %s as %s", (url, kind) => {
    expect(() => validateWebhookUrl(url, kind)).toThrow(WebhookUrlError);
  });
});

describe("payloads", () => {
  const alert = { orgId: "o1", workspaceId: "w1", type: "anomaly.spend_spike", title: "Spend <jumped> & more", body: "Line 1", link: "/w/w1/campaigns" };

  it("escapes Slack control characters and links back to the app", () => {
    const { text } = slackBody(alert);
    expect(text).toContain("*Spend &lt;jumped&gt; &amp; more*");
    expect(text).toMatch(/<http[^|]+\/w\/w1\/campaigns\|Open in Ashniva Ads>/);
  });

  it("sends a stable JSON shape to generic webhooks", () => {
    expect(genericBody(alert, new Date("2026-11-03T10:00:00Z"))).toEqual({
      event: "anomaly.spend_spike",
      title: "Spend <jumped> & more",
      body: "Line 1",
      url: expect.stringContaining("/w/w1/campaigns"),
      actions: [],
      orgId: "o1",
      workspaceId: "w1",
      sentAt: "2026-11-03T10:00:00.000Z",
    });
  });

  it("signs timestamp.body with HMAC-SHA256", () => {
    expect(signPayload("s3cret", "1700000000", '{"a":1}')).toBe(`sha256=${createHmac("sha256", "s3cret").update('1700000000.{"a":1}').digest("hex")}`);
  });
});

describe("channelWants", () => {
  const spike = { type: "anomaly.spend_spike", workspaceId: "w1" };
  const all = { workspaceIds: [], events: [] };

  it("an unrestricted channel gets everything, including organization-wide alerts", () => {
    expect(channelWants(all, spike)).toBe(true);
    expect(channelWants(all, { type: "ai.low_balance", workspaceId: null })).toBe(true);
    expect(channelWants(all, { type: "something.new" })).toBe(true);
  });

  it("a channel limited to a workspace never gets another workspace's alerts", () => {
    const client = { workspaceIds: ["w1"], events: [] };
    expect(channelWants(client, spike)).toBe(true);
    expect(channelWants(client, { ...spike, workspaceId: "w2" })).toBe(false);
  });

  it("a workspace-limited channel does not get alerts that belong to no workspace", () => {
    expect(channelWants({ workspaceIds: ["w1"], events: [] }, { type: "ai.low_balance" })).toBe(false);
    expect(channelWants({ workspaceIds: ["w1"], events: [] }, { type: "ai.low_balance", workspaceId: null })).toBe(false);
  });

  it("limits by alert group", () => {
    const only = { workspaceIds: [], events: ["anomalies", "spend"] };
    expect(channelWants(only, spike)).toBe(true);
    expect(channelWants(only, { type: "spend.billing_issue", workspaceId: "w1" })).toBe(true);
    expect(channelWants(only, { type: "rule.triggered", workspaceId: "w1" })).toBe(false);
    expect(channelWants(only, { type: "unknown.kind", workspaceId: "w1" })).toBe(false);
  });

  it("applies workspace and group limits together", () => {
    const hook = { workspaceIds: ["w1"], events: ["rules"] };
    expect(channelWants(hook, { type: "rule.triggered", workspaceId: "w1" })).toBe(true);
    expect(channelWants(hook, { type: "rule.triggered", workspaceId: "w2" })).toBe(false);
    expect(channelWants(hook, { type: "anomaly.spend_spike", workspaceId: "w1" })).toBe(false);
  });
});

describe("WhatsApp", () => {
  const ok = { phoneNumberId: "109876543210987", recipients: ["+91 98765-43210", "919876543210", "+1 (415) 555 0100"], template: "ashniva_alert" };

  it("normalizes numbers to digits, removes duplicates and defaults the language", () => {
    expect(parseWhatsAppConfig(ok)).toEqual({ phoneNumberId: "109876543210987", to: ["919876543210", "14155550100"], template: "ashniva_alert", language: "en" });
  });

  it.each([
    [{ phoneNumberId: "abc" }, /phone number ID/],
    [{ phoneNumberId: "+919876543210" }, /phone number ID/],
    [{ recipients: [] }, /at least one/],
    [{ recipients: ["98765"] }, /country code/],
    [{ recipients: ["1","2","3","4","5","6"].map((d) => `+9198765432${d}0`) }, /up to 5/],
    [{ template: "Ashniva Alert" }, /Template names/],
    [{ language: "english" }, /language code/],
  ])("rejects bad input %#", (patch, message) => {
    expect(() => parseWhatsAppConfig({ ...ok, ...patch })).toThrow(message);
  });

  it("flattens line breaks, which template variables don't allow", () => {
    const text = whatsappText({ orgId: "o", type: "x", title: "Spend jumped", body: "A: 1\nB: 2\t\tC", link: "/w/w1/campaigns" });
    expect(text).not.toMatch(/[\n\t]/);
    expect(text).toContain("Spend jumped · A: 1 · B: 2 · C");
    expect(text).toContain("/w/w1/campaigns");
  });
});
