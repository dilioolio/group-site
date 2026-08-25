// First-run wizard. Until SETUP_COMPLETE is set in the config table every
// request (except this page, its API and the assets it needs) is redirected to
// /setup. One POST stores the password hash, organiser details and Resend key,
// and generates the signing + VAPID keys in-Worker — the user never sees a
// terminal or a secret. After that the endpoint is locked (409); later changes
// go through the admin Settings page.

import { Hono } from "hono";
import { saveConfig, hashPassword, generateVapidKeys } from "../lib/config.js";
import { isValidEmail, jsonError, randomToken } from "../lib/utils.js";

export const setupRoutes = new Hono();

const OPEN_PATHS = /^\/(setup|api\/setup|api\/site|app\.css|site\.css|js\/|icons\/|manifest\.json|asset\/|health)/;

export function setupGate() {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (c.env.SETUP_COMPLETE) {
      if (path === "/setup") return c.redirect("/admin");
      return next();
    }
    if (OPEN_PATHS.test(path)) return next();
    return c.redirect("/setup");
  };
}

setupRoutes.get("/setup", (c) => c.env.ASSETS.fetch(new Request(new URL("/setup.html", c.req.url))));

// Ask Resend whether the key works and whether the sending domain is verified.
// A bad key blocks setup; an unverified domain is only a warning because DNS
// records take a while to propagate and the user can fix it later.
export async function checkResend(apiKey, fromEmail) {
  const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${apiKey}` } });
  // Resend answers 400 "API key is invalid" (not 401) for a bad key; treat any
  // 4xx as rejected and only 5xx/network trouble as "can't tell right now".
  if (res.status >= 400 && res.status < 500) return { keyOk: false };
  if (!res.ok) return { keyOk: true, domainStatus: "unknown" };
  const domain = fromEmail.split("@")[1].toLowerCase();
  const { data = [] } = await res.json().catch(() => ({}));
  const d = data.find((x) => String(x.name).toLowerCase() === domain);
  return { keyOk: true, domainStatus: d ? d.status : "missing" };
}

setupRoutes.post("/api/setup", async (c) => {
  if (c.env.SETUP_COMPLETE) return jsonError(c, 409, "already_set_up");
  let b;
  try { b = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }

  const password = String(b.password || "");
  const adminName = String(b.admin_name || "").trim();
  const siteName = String(b.site_name || "").trim() || "Group Site";
  const fromEmail = String(b.from_email || "").trim().toLowerCase();
  const replyTo = String(b.reply_to || "").trim().toLowerCase();
  const resendKey = String(b.resend_api_key || "").trim();
  const timezone = String(b.timezone || "").trim() || "UTC";

  if (password.length < 8) return jsonError(c, 400, "password_too_short");
  if (!adminName) return jsonError(c, 400, "missing_name");
  if (!isValidEmail(fromEmail)) return jsonError(c, 400, "bad_from_email");
  if (replyTo && !isValidEmail(replyTo)) return jsonError(c, 400, "bad_reply_to");
  if (!resendKey.startsWith("re_")) return jsonError(c, 400, "bad_resend_key");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { return jsonError(c, 400, "bad_timezone"); }

  // SKIP_RESEND_CHECK in .dev.vars lets local dev finish setup with a fake key.
  const resend = c.env.SKIP_RESEND_CHECK ? { keyOk: true, domainStatus: "skipped" } : await checkResend(resendKey, fromEmail);
  if (!resend.keyOk) return jsonError(c, 400, "resend_key_rejected");

  // Keys are generated once. If setup is re-run (password reset via deleting
  // SETUP_COMPLETE), keep the existing keys so members' push subscriptions and
  // gallery links stay valid.
  const vapid = c.env.VAPID_PRIVATE_KEY ? null : await generateVapidKeys();
  await saveConfig(c.env, {
    ADMIN_PASSWORD_HASH: await hashPassword(password),
    ADMIN_NAME: adminName,
    SITE_NAME: siteName,
    FROM_EMAIL: fromEmail,
    REPLY_TO_EMAIL: replyTo,
    RESEND_API_KEY: resendKey,
    TIMEZONE: timezone,
    SESSION_SIGNING_KEY: c.env.SESSION_SIGNING_KEY || randomToken(32),
    VAPID_PUBLIC_KEY: vapid?.publicKey,
    VAPID_PRIVATE_KEY: vapid?.privateKey,
    VAPID_SUBJECT: `mailto:${fromEmail}`,
    SETUP_COMPLETE: "1",
  });
  return c.json({ ok: true, domain_status: resend.domainStatus });
});
