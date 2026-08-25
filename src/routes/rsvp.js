// RSVP endpoint. On a successful RSVP we also email a personal gallery link
// — that doubles as the "magic link" for the private member photo area.

import { Hono } from "hono";
import { isoNow, uuid, normalizeEmail, isValidEmail, jsonError, formatEventDate } from "../lib/utils.js";
import { signGalleryToken, signSubscribeToken } from "../lib/token.js";
import { sendEmail, composeEmail } from "../lib/email.js";
import { rateLimit, clientIp } from "../lib/ratelimit.js";

export const rsvpRoutes = new Hono();

const VALID_STATUS = new Set(["going", "maybe", "cancelled"]);

rsvpRoutes.post("/api/events/:id/rsvp", async (c) => {
  const eventId = c.req.param("id");
  let body;
  try { body = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }
  const name = String(body?.name || "").trim();
  const email = normalizeEmail(body?.email);
  const status = String(body?.status || "going").toLowerCase();

  if (!name) return jsonError(c, 400, "missing_name");
  if (!isValidEmail(email)) return jsonError(c, 400, "bad_email");
  if (!VALID_STATUS.has(status)) return jsonError(c, 400, "bad_status");

  // Every successful RSVP triggers an outbound email, so throttle hard:
  // a bot hammering this endpoint could spam strangers' inboxes from the
  // organiser's Gmail AND drain the ~100/day send quota.
  const ipLimit = await rateLimit(c.env, `rsvp-ip:${clientIp(c)}`, 20, 3600);
  if (!ipLimit.allowed) return jsonError(c, 429, "rate_limited");
  const emailLimit = await rateLimit(c.env, `rsvp-email:${email}`, 5, 3600);
  if (!emailLimit.allowed) return jsonError(c, 429, "rate_limited");

  const event = await c.env.DB.prepare(
    "SELECT id, title, event_date, location, status FROM events WHERE id = ?"
  ).bind(eventId).first();
  if (!event) return c.notFound();
  if (event.status !== "active") return jsonError(c, 409, "event_not_active");
  if (new Date(event.event_date).getTime() < Date.now()) return jsonError(c, 409, "event_passed");

  // Upsert one row per (event, email).
  await c.env.DB.prepare(
    `INSERT INTO rsvps (id, event_id, name, email, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, email) DO UPDATE SET
       name = excluded.name,
       status = excluded.status`
  ).bind(uuid(), eventId, name, email, status, isoNow()).run();

  // Issue + email the gallery magic link, but only for "going"/"maybe".
  // Cancelled RSVPs don't need gallery access.
  if (status !== "cancelled") {
    const ttl = Number(c.env.GALLERY_TOKEN_TTL_DAYS || 30);
    const eventUrl = `${c.env.SITE_URL}/event/${eventId}`;
    const niceDate = formatEventDate(c.env, event.event_date);
    const gallery = !!event.gallery_enabled;
    const link = gallery
      ? `${c.env.SITE_URL}/event/${eventId}/gallery?token=${await signGalleryToken(eventId, email, c.env.SESSION_SIGNING_KEY, ttl)}`
      : eventUrl;
    const messageBody =
      `Thanks for RSVP'ing as "${status}" for:\n\n` +
      `${event.title}\n${niceDate}${event.location ? `\n${event.location}` : ""}\n\n` +
      (gallery
        ? `Event page: ${eventUrl}\n\n` +
          `Your private photo gallery link for this event is below. ` +
          `It's valid ${ttl} days; photos in the gallery auto-delete 30 days after the event.\n\n`
        : "") +
      `(If you didn't RSVP, you can ignore this email.)`;
    const { body, htmlBody } = composeEmail(c.env, {
      recipientName: name,
      body: messageBody,
      link,
      linkLabel: gallery ? "Open your photo gallery" : "Event page",
    });
    // Fire-and-forget — don't block the response if Gmail is briefly slow.
    c.executionCtx.waitUntil(sendEmail(c.env, {
      to: [email],
      subject: `RSVP confirmed: ${event.title}`,
      body,
      htmlBody,
    }));
  }

  // Short-lived proof of email ownership — /api/push/subscribe requires it.
  const pushToken = await signSubscribeToken(email, c.env.SESSION_SIGNING_KEY);

  return c.json({ ok: true, status, push_token: pushToken });
});
