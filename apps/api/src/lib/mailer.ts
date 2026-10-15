import { BRAND } from "@ashniva/shared";
import { logger } from "./logger";

/** Escape user-provided text before placing it in email HTML. */
export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface Mail {
  to: string;
  subject: string;
  heading: string;
  body: string;
  cta?: { label: string; url: string };
}

function render({ heading, body, cta }: Mail) {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${cta.url}" style="background:#3b5bdb;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${cta.label}</a></p>
       <p style="color:#868e96;font-size:12px">Or paste this link into your browser:<br>${cta.url}</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Inter,Segoe UI,Arial,sans-serif">
  <div style="max-width:520px;margin:40px auto;background:#fff;border:1px solid #e9ecef;border-radius:12px;padding:36px">
    <div style="font-weight:700;font-size:16px;color:#1c2333;margin-bottom:28px">${BRAND.name}</div>
    <h1 style="font-size:20px;color:#1c2333;margin:0 0 12px">${heading}</h1>
    <p style="color:#495057;font-size:14px;line-height:1.6">${body}</p>
    ${button}
  </div>
  <p style="text-align:center;color:#adb5bd;font-size:12px">© ${new Date().getFullYear()} ${BRAND.company}</p>
</body></html>`;
}

/** Sends through Resend when configured; otherwise logs the email (development). */
export async function sendMail(mail: Mail) {
  // Read on every send: the admin console can change these at runtime.
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const EMAIL_FROM = process.env.EMAIL_FROM || "Ashniva Ads <no-reply@ashniva.com>";
  if (!RESEND_API_KEY) {
    logger.info({ to: mail.to, subject: mail.subject, link: mail.cta?.url }, "📧 Email (not sent: RESEND_API_KEY missing)");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: EMAIL_FROM, to: mail.to, subject: mail.subject, html: render(mail) }),
  });
  if (!res.ok) logger.error({ status: res.status, body: await res.text() }, "Failed to send email");
}
