// Public, read-only event endpoints + the public image-serving route + push subscribe.

import { Hono } from "hono";
import { isoNow, uuid, normalizeEmail, isValidEmail, jsonError } from "../lib/utils.js";
import { verifySubscribeToken } from "../lib/token.js";

export const publicRoutes = new Hono();

// GET /api/events — every event with its primary image and RSVP count.
// The homepage groups these client-side into Today / Upcoming / Previous.
// Hikes older than 90 days are hidden from the public list (admins still see
// everything via /api/admin/events). Cancelled events are included so the UI
// can dim them and display the cancelled banner.
publicRoutes.get("/api/events", async (c) => {
  const cutoff = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
  const rows = (await c.env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.event_date, e.location, e.status,
            e.category, e.gallery_enabled,
            (SELECT r2_key FROM event_images
              WHERE event_id = e.id AND is_primary = 1
              ORDER BY sort_order LIMIT 1) AS primary_image_key,
            (SELECT COUNT(*) FROM rsvps
              WHERE event_id = e.id AND status != 'cancelled') AS rsvp_count
       FROM events e
      WHERE e.event_date >= ?
      ORDER BY e.event_date ASC`
  ).bind(cutoff).all()).results || [];
  return c.json({ events: rows });
});

// GET /api/events/:id — single event detail, all image keys, RSVP count.
publicRoutes.get("/api/events/:id", async (c) => {
  const id = c.req.param("id");
  const event = await c.env.DB.prepare(
    "SELECT id, title, description, event_date, location, status, category, gallery_enabled, created_at, updated_at FROM events WHERE id = ?"
  ).bind(id).first();
  if (!event) return c.notFound();

  const images = (await c.env.DB.prepare(
    "SELECT id, r2_key, is_primary, sort_order, alt_text FROM event_images WHERE event_id = ? ORDER BY is_primary DESC, sort_order ASC"
  ).bind(id).all()).results || [];

  const rsvpCount = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM rsvps WHERE event_id = ? AND status != 'cancelled'"
  ).bind(id).first())?.n || 0;

  // Notify-tab + Broadcast-tab messages for this hike, newest first. The frontend
  // hides this section for events that already happened.
  const messages = (await c.env.DB.prepare(
    `SELECT kind, subject, body, sent_at FROM broadcasts
      WHERE event_id = ? ORDER BY sent_at DESC`
  ).bind(id).all()).results || [];

  return c.json({ event, images, rsvp_count: rsvpCount, messages });
});

// GET /img/:key — stream a public (organiser) image from Workers KV.
// IMPORTANT: this is ONLY for event_images. Member photos are token-gated elsewhere.
publicRoutes.get("/img/:key{.+}", async (c) => {
  const key = c.req.param("key");
  // Whitelist, not blacklist: this route serves organiser event images and
  // nothing else. New private prefixes added later are excluded by default.
  if (!key.startsWith("event-images/")) return c.notFound();

  const { value, metadata } = await c.env.PHOTOS.getWithMetadata(key, "stream");
  if (!value) return c.notFound();

  const headers = new Headers();
  headers.set("Content-Type", metadata?.contentType || "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(value, { headers });
});

// GET /api/push/public-key — VAPID public key for pushManager.subscribe().
publicRoutes.get("/api/push/public-key", (c) => {
  if (!c.env.VAPID_PUBLIC_KEY) return jsonError(c, 500, "push_not_configured");
  return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — { token, subscription }
// `token` is the short-lived subscribe token returned by a successful RSVP.
// Requiring it proves the subscriber controls that email — without it, anyone
// could register their own device under a member's address and receive that
// member's notifications (including unique broadcast-confirm links).
publicRoutes.post("/api/push/subscribe", async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }
  const sub = body?.subscription;
  const r = await verifySubscribeToken(body?.token, c.env.SESSION_SIGNING_KEY);
  if (!r.ok) return jsonError(c, 401, "bad_subscribe_token", { reason: r.reason });
  const email = r.email;
  if (!isValidEmail(email)) return jsonError(c, 400, "bad_email");
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return jsonError(c, 400, "bad_subscription");
  }

  // Upsert by endpoint — re-subscribing the same device keeps one row.
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, email, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET email = excluded.email,
                                         p256dh = excluded.p256dh,
                                         auth = excluded.auth`
  ).bind(uuid(), email, sub.endpoint, sub.keys.p256dh, sub.keys.auth, isoNow()).run();

  return c.json({ ok: true });
});
