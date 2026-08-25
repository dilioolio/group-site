// Middleware that gates routes which carry a per-event gallery token.
// The route MUST have an `:id` param — it's the event id we bind the token to.

import { getCookie } from "hono/cookie";
import { verifyGalleryToken } from "./token.js";

export function requireGalleryToken() {
  return async (c, next) => {
    const eventId = c.req.param("id");
    if (!eventId) return c.json({ error: "missing_event_id" }, 400);
    const token =
      c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ||
      getCookie(c, "gallery_token") ||
      c.req.query("token");
    const res = await verifyGalleryToken(token, eventId, c.env.SESSION_SIGNING_KEY);
    if (!res.ok) return c.json({ error: "access_denied", reason: res.reason }, 401);
    const ev = await c.env.DB.prepare("SELECT gallery_enabled FROM events WHERE id = ?").bind(eventId).first();
    if (!ev || !ev.gallery_enabled) return c.json({ error: "gallery_disabled" }, 403);
    c.set("memberEmail", res.email);
    await next();
  };
}
