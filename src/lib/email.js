// sendEmail()/sendEmails() — the SINGLE choke point for outbound mail. Uses
// Resend (https://resend.com). Config comes from the D1 config table via
// mergeEnv(): RESEND_API_KEY, FROM_EMAIL, ADMIN_NAME, REPLY_TO_EMAIL.
//
// composeEmail() is the SINGLE place that decides what an outbound message looks
// like (greeting, body, plain-text link, signature, contact-PS). Keeping every
// outbound mail in a consistent "personal note from the organiser" voice helps
// deliverability — spam filters score consistent transactional patterns far
// better than per-route bespoke HTML.

const RESEND = "https://api.resend.com";
const BATCH = 100; // Resend's per-call maximum

export async function sendEmail(env, msg) {
  return sendEmails(env, [msg]);
}

/**
 * @param {Array<{to: string|string[], subject: string, body?: string, htmlBody?: string}>} messages
 * @returns {Promise<{ok: boolean, sent: number, reason?: string}>}
 */
export async function sendEmails(env, messages) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    console.warn("sendEmails: RESEND_API_KEY/FROM_EMAIL not configured; dropping", messages.length, "messages");
    return { ok: false, sent: 0, reason: "not_configured" };
  }
  if (!messages?.length) return { ok: true, sent: 0 };
  const from = `${env.ADMIN_NAME || "Events"} <${env.FROM_EMAIL}>`;
  let sent = 0;
  for (let i = 0; i < messages.length; i += BATCH) {
    const chunk = messages.slice(i, i + BATCH).map((m) => ({
      from,
      to: Array.isArray(m.to) ? m.to : [m.to],
      subject: m.subject,
      text: m.body,
      html: m.htmlBody,
      reply_to: env.REPLY_TO_EMAIL || undefined,
    }));
    const res = await fetch(`${RESEND}/emails/batch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      console.error("Resend error", res.status, await res.text().catch(() => ""));
      return { ok: false, sent, reason: "resend_http_" + res.status };
    }
    sent += chunk.length;
  }
  return { ok: true, sent };
}

// --- Email composition -----------------------------------------------------

function escapeHtmlBasic(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Build matched plain-text and lightweight-HTML versions of a transactional email.
 *
 * @param {object} env  - Worker env (used for ADMIN_NAME and SITE_URL).
 * @param {object} opts
 * @param {string} [opts.recipientName] - For the "Hi <name>," greeting.
 * @param {string} opts.body            - The main message (plain text, may contain newlines).
 * @param {string} [opts.link]          - A single primary URL to include. Rendered as a plain
 *                                        clickable link, never a button — buttons read as
 *                                        marketing and hurt deliverability.
 * @param {string} [opts.linkLabel]     - Short label that precedes the URL (e.g. "Open the hike").
 * @returns {{ body: string, htmlBody: string }}
 */
export function composeEmail(env, { recipientName, body, link, linkLabel }) {
  const adminName = env.ADMIN_NAME || "the organiser";
  const siteHost = String(env.SITE_URL || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";
  const sig = `— ${adminName}${siteHost ? ` (via ${siteHost})` : ""}`;
  const ps = "PS: To make sure future updates don't get filed as spam, "
    + "add this email address to your contacts.";

  // Plain text — Gmail and most clients pick this when "prefer plain" is on.
  const linkBlockText = link
    ? `\n${linkLabel ? linkLabel + ":\n" : ""}${link}\n`
    : "";
  const text = `${greeting}\n\n${body}\n${linkBlockText}\n${sig}\n\n${ps}\n`;

  // HTML — intentionally minimal. No button, no images, no tracking pixels.
  const linkBlockHtml = link
    ? `<p>${escapeHtmlBasic(linkLabel || "Link")}: <a href="${escapeHtmlBasic(link)}">${escapeHtmlBasic(link)}</a></p>`
    : "";
  const htmlBody = [
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">`,
      `<p>${escapeHtmlBasic(greeting)}</p>`,
      `<p>${escapeHtmlBasic(body).replaceAll("\n", "<br>")}</p>`,
      linkBlockHtml,
      `<p>${escapeHtmlBasic(sig)}</p>`,
      `<p style="color:#666;font-size:12px"><em>${escapeHtmlBasic(ps)}</em></p>`,
    `</div>`,
  ].join("");

  return { body: text, htmlBody };
}
