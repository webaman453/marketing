import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const smtp = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: "m1" }));
  const verify = vi.fn(async () => true);
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, verify, close }));
  return { sendMail, verify, close, createTransport };
});

vi.mock("nodemailer", () => ({ default: { createTransport: smtp.createTransport } }));

import { deliverEmail, esc, sendMail, verifySmtp } from "./mailer";

const MAIL_KEYS = ["EMAIL_PROVIDER", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "RESEND_API_KEY", "EMAIL_FROM"] as const;
const saved: Record<string, string | undefined> = {};

function setMailEnv(values: Partial<Record<(typeof MAIL_KEYS)[number], string>>) {
  for (const k of MAIL_KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

const SMTP_ENV = { SMTP_HOST: "smtp.example.test", SMTP_USER: "mailer@example.test", SMTP_PASSWORD: "pw" };

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const k of MAIL_KEYS) saved[k] = process.env[k];
  smtp.sendMail.mockClear();
  smtp.createTransport.mockClear();
  smtp.close.mockClear();
  smtp.verify.mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
});

afterEach(() => {
  for (const k of MAIL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const mail = { to: ["a@example.test"], subject: "Hello", html: "<p>Hi</p>" };

describe("esc", () => {
  it("escapes the five HTML special characters", () => {
    expect(esc(`<script>alert("x") & 'y'</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;");
  });

  it("leaves plain text alone", () => {
    expect(esc("Plain text 123")).toBe("Plain text 123");
  });
});

describe("deliverEmail", () => {
  it("returns false and sends nothing when no provider is configured", async () => {
    setMailEnv({});
    expect(await deliverEmail(mail)).toBe(false);
    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends with SMTP when SMTP is configured", async () => {
    setMailEnv({ ...SMTP_ENV, EMAIL_FROM: "Brand <hi@example.test>" });
    const attachments = [{ filename: "r.pdf", content: Buffer.from("pdf") }];
    expect(await deliverEmail({ ...mail, attachments })).toBe(true);
    expect(smtp.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.example.test", port: 587, secure: false, auth: { user: "mailer@example.test", pass: "pw" } }),
    );
    expect(smtp.sendMail).toHaveBeenCalledWith({
      from: "Brand <hi@example.test>",
      to: ["a@example.test"],
      subject: "Hello",
      html: "<p>Hi</p>",
      attachments: [{ filename: "r.pdf", content: Buffer.from("pdf") }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses SSL on port 465 and reuses the transport until the settings change", async () => {
    setMailEnv({ ...SMTP_ENV, SMTP_PORT: "465" });
    await deliverEmail(mail);
    await deliverEmail(mail);
    expect(smtp.createTransport).toHaveBeenCalledTimes(1);
    expect(smtp.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ port: 465, secure: true }));

    const closes = smtp.close.mock.calls.length;
    process.env.SMTP_PASSWORD = "changed";
    await deliverEmail(mail);
    expect(smtp.createTransport).toHaveBeenCalledTimes(2);
    expect(smtp.close).toHaveBeenCalledTimes(closes + 1);
  });

  it("prefers SMTP over Resend when both have keys and no provider is chosen", async () => {
    setMailEnv({ ...SMTP_ENV, RESEND_API_KEY: "re_key" });
    await deliverEmail(mail);
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends with Resend when EMAIL_PROVIDER=RESEND even if SMTP is set", async () => {
    setMailEnv({ ...SMTP_ENV, RESEND_API_KEY: "re_key", EMAIL_PROVIDER: "RESEND" });
    expect(await deliverEmail({ ...mail, attachments: [{ filename: "a.txt", content: Buffer.from("hello") }] })).toBe(true);
    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ to: ["a@example.test"], subject: "Hello", html: "<p>Hi</p>" });
    expect(body.from).toMatch(/no-reply@ashniva\.com/);
    expect(body.attachments).toEqual([{ filename: "a.txt", content: Buffer.from("hello").toString("base64") }]);
  });

  it("sends nothing when the chosen provider has no keys", async () => {
    setMailEnv({ RESEND_API_KEY: "re_key", EMAIL_PROVIDER: "SMTP" });
    expect(await deliverEmail(mail)).toBe(false);
    setMailEnv({ ...SMTP_ENV, EMAIL_PROVIDER: "resend" });
    expect(await deliverEmail(mail)).toBe(false);
    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws with Resend's answer when it rejects the email", async () => {
    setMailEnv({ RESEND_API_KEY: "re_key" });
    fetchSpy.mockResolvedValueOnce(new Response("domain not verified", { status: 403 }));
    await expect(deliverEmail(mail)).rejects.toThrow("Email send failed (403): domain not verified");
  });

  it("propagates SMTP errors", async () => {
    setMailEnv(SMTP_ENV);
    smtp.sendMail.mockRejectedValueOnce(new Error("535 auth failed"));
    await expect(deliverEmail(mail)).rejects.toThrow("535 auth failed");
  });
});

describe("verifySmtp", () => {
  it("checks the login on the current transport", async () => {
    setMailEnv(SMTP_ENV);
    await verifySmtp();
    expect(smtp.verify).toHaveBeenCalledTimes(1);
  });
});

describe("sendMail", () => {
  it("logs the email instead of sending when nothing is configured", async () => {
    setMailEnv({});
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await sendMail({
      to: "b@example.test",
      subject: "Reset",
      heading: "Reset",
      body: "x",
      cta: { label: "Go", url: "http://localhost/reset?token=abc" },
      attachments: [{ filename: "f.pdf", content: Buffer.from("") }],
    });
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]![0]);
    expect(line).toContain("to=b@example.test");
    expect(line).toContain('subject="Reset"');
    expect(line).toContain("link=http://localhost/reset?token=abc");
    expect(line).toContain("attachments=f.pdf");
  });

  it("renders a branded HTML email and escapes brand, CTA and logo values", async () => {
    setMailEnv(SMTP_ENV);
    await sendMail({
      to: ["c@example.test", "d@example.test"],
      subject: "Report",
      heading: "Weekly report",
      body: "<strong>trusted</strong>",
      cta: { label: `View "now" <b>`, url: "https://x.test/r?a=1&b=2" },
      brand: { name: `Acme <Ads> & "Co"`, color: "#ff0000", logoUrl: `https://x.test/logo.png?"onerror="x` },
    });
    const sent = (smtp.sendMail.mock.calls as unknown as [{ to: string[]; html: string }][])[0]![0];
    expect(sent.to).toEqual(["c@example.test", "d@example.test"]);
    const html = sent.html;
    expect(html).toContain("<h1");
    expect(html).toContain("Weekly report");
    expect(html).toContain("<strong>trusted</strong>");
    expect(html).toContain("background:#ff0000");
    expect(html).toContain("View &quot;now&quot; &lt;b&gt;");
    expect(html).toContain("https://x.test/r?a=1&amp;b=2");
    expect(html).toContain("Acme &lt;Ads&gt; &amp; &quot;Co&quot;");
    expect(html).toContain(`src="https://x.test/logo.png?&quot;onerror=&quot;x"`);
    expect(html).not.toContain("<Ads>");
    expect(html).not.toContain(`"onerror="`);
  });

  it("uses the default brand and footer without white-label options", async () => {
    setMailEnv(SMTP_ENV);
    await sendMail({ to: "e@example.test", subject: "Hi", heading: "Hi", body: "b" });
    const html = (smtp.sendMail.mock.calls as unknown as [{ html: string }][])[0]![0].html;
    expect(html).toContain("background:#f4f5f7");
    expect(html).toContain(`© ${new Date().getFullYear()}`);
    expect(html).not.toContain("<a href=");
  });
});
