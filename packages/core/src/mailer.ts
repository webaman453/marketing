import { BRAND } from "@ashniva/shared";

/** Escape user-provided text before placing it in email HTML. */
export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface Mail {
  to: string | string[];
  subject: string;
  heading: string;
  /** Trusted HTML; escape any user input with `esc`. */
  body: string;
  cta?: { label: string; url: string };
  attachments?: { filename: string; content: Buffer }[];
  /** White-label overrides for client-facing mail */
  brand?: { name: string; color?: string | null; logoUrl?: string | null };
}

function render({ heading, body, cta, brand }: Mail) {
  const color = brand?.color || "#3b5bdb";
  const name = esc(brand?.name ?? BRAND.name);
  const logo = brand?.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${name}" style="max-height:32px;max-width:160px">`
    : `<div style="font-weight:700;font-size:16px;color:#1c2333">${name}</div>`;
  const button = cta
    ? `<p style="margin:28px 0"><a href="${esc(cta.url)}" style="background:${color};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(cta.label)}</a></p>
       <p style="color:#868e96;font-size:12px">Or paste this link into your browser:<br>${esc(cta.url)}</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Inter,Segoe UI,Arial,sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border:1px solid #e9ecef;border-radius:12px;padding:36px">
    <div style="margin-bottom:28px">${logo}</div>
    <h1 style="font-size:20px;color:#1c2333;margin:0 0 12px">${heading}</h1>
    <div style="color:#495057;font-size:14px;line-height:1.6">${body}</div>
    ${button}
  </div>
  <p style="text-align:center;color:#adb5bd;font-size:12px">${brand ? name : `© ${new Date().getFullYear()} ${BRAND.company}`}</p>
</body></html>`;
}

/** Sends through Resend when configured; otherwise logs the email (development). */
export async function sendMail(mail: Mail): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const to = Array.isArray(mail.to) ? mail.to : [mail.to];
  if (!key) {
    console.info(
      `📧 [email not sent: RESEND_API_KEY missing] to=${to.join(",")} subject="${mail.subject}"${mail.cta ? ` link=${mail.cta.url}` : ""}${
        mail.attachments?.length ? ` attachments=${mail.attachments.map((a) => a.filename).join(",")}` : ""
      }`,
    );
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || `${BRAND.name} <no-reply@ashniva.com>`,
      to,
      subject: mail.subject,
      html: render(mail),
      attachments: mail.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
    }),
  });
  if (!res.ok) throw new Error(`Email send failed (${res.status}): ${await res.text()}`);
}
