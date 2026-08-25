// Admin endpoints. All routes (except /login) require a valid admin session token.

import { Hono } from "hono";
import { requireAdmin, checkAdminPassword, issueAdminSession } from "../lib/auth.js";
import { sendEmail, sendEmails, composeEmail } from "../lib/email.js";
import { sendPushToSubscriptions } from "../lib/push.js";
import {
  isoNow, uuid, jsonError, escapeHtml, normalizeEmail, isValidEmail, formatEventDate,
} from "../lib/utils.js";
import { rateLimit, clientIp } from "../lib/ratelimit.js";

export const adminRoutes = new Hono();

const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_STATUS = new Set(["active", "cancelled"]);
const MATERIAL_FIELDS = ["event_date", "location", "status"];

// --- session ---------------------------------------------------------------

adminRoutes.post("/api/admin/login", async (c) => {
  // Shared password + unlimited attempts = brute-forceable. 10 tries per
  // 15 minutes per IP is generous for a human, hopeless for a script.
  const rl = await rateLimit(c.env, `login:${clientIp(c)}`, 10, 900);
  if (!rl.allowed) return jsonError(c, 429, "rate_limited");

  let body;
  try { body = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }
  const ok = await checkAdminPassword(body?.password, c.env);
  if (!ok) return jsonError(c, 401, "bad_password");
  const token = await issueAdminSession(c.env);
  return c.json({ ok: true, token });
});

// --- events CRUD -----------------------------------------------------------

// List ALL events (including past and cancelled) for the admin dashboard.
// The public /api/events filters to upcoming + active; admins need to see everything.
adminRoutes.get("/api/admin/events", requireAdmin(), async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT e.id, e.title, e.event_date, e.location, e.status,
            (SELECT r2_key FROM event_images
              WHERE event_id = e.id AND is_primary = 1
              ORDER BY sort_order LIMIT 1) AS primary_image_key,
            (SELECT COUNT(*) FROM rsvps
              WHERE event_id = e.id AND status != 'cancelled') AS rsvp_count
       FROM events e
      ORDER BY e.event_date DESC`
  ).all()).results || [];
  return c.json({ events: rows });
});

adminRoutes.post("/api/admin/events", requireAdmin(), async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }
  const title = String(body?.title || "").trim();
  const description = String(body?.description || "").trim();
  const eventDate = String(body?.event_date || "").trim();
  const location = body?.location ? String(body.location).trim() : null;
  const status = ALLOWED_STATUS.has(body?.status) ? body.status : "active";

  if (!title) return jsonError(c, 400, "missing_title");
  if (!description) return jsonError(c, 400, "missing_description");
  if (!eventDate || Number.isNaN(Date.parse(eventDate))) return jsonError(c, 400, "bad_event_date");

  // No two active hikes at the same start time. Cancelled ones don't block.
  const clash = await c.env.DB.prepare(
    "SELECT id, title FROM events WHERE event_date = ? AND status = 'active'"
  ).bind(eventDate).first();
  if (clash) return c.json({ error: "time_conflict", conflicts_with: clash.title }, 409);

  const id = uuid();
  const now = isoNow();
  await c.env.DB.prepare(
    `INSERT INTO events (id, title, description, event_date, location, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, title, description, eventDate, location, status, now, now).run();

  return c.json({ ok: true, id });
});

adminRoutes.put("/api/admin/events/:id", requireAdmin(), async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT * FROM events WHERE id = ?"
  ).bind(id).first();
  if (!existing) return c.notFound();

  let body;
  try { body = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }

  const next = {
    title:       body.title       !== undefined ? String(body.title).trim()       : existing.title,
    description: body.description !== undefined ? String(body.description).trim() : existing.description,
    event_date:  body.event_date  !== undefined ? String(body.event_date).trim()  : existing.event_date,
    location:    body.location    !== undefined ? (body.location ? String(body.location).trim() : null) : existing.location,
    status:      body.status      !== undefined
                   ? (ALLOWED_STATUS.has(body.status) ? body.status : existing.status)
                   : existing.status,
  };

  if (!next.title) return jsonError(c, 400, "missing_title");
  if (!next.description) return jsonError(c, 400, "missing_description");
  if (!next.event_date || Number.isNaN(Date.parse(next.event_date))) return jsonError(c, 400, "bad_event_date");

  // Same time-conflict rule as create — only checked when status would stay active.
  if (next.status === "active") {
    const clash = await c.env.DB.prepare(
      "SELECT id, title FROM events WHERE event_date = ? AND status = 'active' AND id != ?"
    ).bind(next.event_date, id).first();
    if (clash) return c.json({ error: "time_conflict", conflicts_with: clash.title }, 409);
  }

  await c.env.DB.prepare(
    `UPDATE events SET title=?, description=?, event_date=?, location=?, status=?, updated_at=? WHERE id=?`
  ).bind(next.title, next.description, next.event_date, next.location, next.status, isoNow(), id).run();

  // Material-change detection: if event_date/location/status moved, notify attendees.
  const changed = MATERIAL_FIELDS.filter((k) => String(existing[k] ?? "") !== String(next[k] ?? ""));
  let notified = null;
  if (changed.length > 0 && !body.suppress_notify) {
    // On cancellation, the admin picks a short reason in the UI — surface it to attendees.
    const cancelReason = (next.status === "cancelled" && body.cancel_reason)
      ? String(body.cancel_reason).trim().slice(0, 30)
      : null;
    notified = await notifyAttendees(c, id, next, changed, { cancelReason });
  }

  return c.json({ ok: true, changed, notified });
});

// --- images ----------------------------------------------------------------

adminRoutes.post("/api/admin/events/:id/images", requireAdmin(), async (c) => {
  const eventId = c.req.param("id");
  const event = await c.env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(eventId).first();
  if (!event) return c.notFound();

  let form;
  try { form = await c.req.formData(); } catch { return jsonError(c, 400, "bad_form"); }

  // Accept either a single `file` or multiple `files[]` entries.
  const files = [];
  for (const v of form.getAll("files[]")) if (v instanceof File) files.push(v);
  const single = form.get("file");
  if (single instanceof File) files.push(single);
  if (files.length === 0) return jsonError(c, 400, "no_files");

  const isPrimary = form.get("is_primary") === "1";
  const altText = form.get("alt_text") ? String(form.get("alt_text")).trim() : null;

  // Figure out the next sort_order for this event.
  const maxRow = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM event_images WHERE event_id = ?"
  ).bind(eventId).first();
  let nextSort = (maxRow?.max_sort ?? -1) + 1;

  // If marking primary, clear current primary first.
  if (isPrimary) {
    await c.env.DB.prepare(
      "UPDATE event_images SET is_primary = 0 WHERE event_id = ?"
    ).bind(eventId).run();
  }

  const created = [];
  for (const file of files) {
    if (!ALLOWED_IMAGE_MIME.has(file.type)) {
      return jsonError(c, 415, "unsupported_type", { type: file.type });
    }
    if (file.size <= 0 || file.size > 15 * 1024 * 1024) {
      return jsonError(c, 413, "file_too_large");
    }
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const imageId = uuid();
    const r2Key = `event-images/${eventId}/${imageId}.${ext}`;
    // No expirationTtl — event/organiser images live forever.
    await c.env.PHOTOS.put(r2Key, await file.arrayBuffer(), {
      metadata: { contentType: file.type },
    });
    // Only the first uploaded file in this batch gets is_primary (if requested).
    const thisIsPrimary = isPrimary && created.length === 0 ? 1 : 0;
    await c.env.DB.prepare(
      `INSERT INTO event_images (id, event_id, r2_key, is_primary, sort_order, alt_text)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(imageId, eventId, r2Key, thisIsPrimary, nextSort++, altText).run();
    created.push({ id: imageId, r2_key: r2Key, is_primary: !!thisIsPrimary });
  }

  return c.json({ ok: true, images: created });
});

adminRoutes.put("/api/admin/events/:id/images/:imageId", requireAdmin(), async (c) => {
  // For setting primary or reordering. Body: { is_primary?: bool, sort_order?: number, alt_text?: string }
  const { id: eventId, imageId } = c.req.param();
  let body;
  try { body = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }

  const row = await c.env.DB.prepare(
    "SELECT id FROM event_images WHERE id = ? AND event_id = ?"
  ).bind(imageId, eventId).first();
  if (!row) return c.notFound();

  if (body.is_primary === true) {
    await c.env.DB.prepare(
      "UPDATE event_images SET is_primary = 0 WHERE event_id = ?"
    ).bind(eventId).run();
    await c.env.DB.prepare(
      "UPDATE event_images SET is_primary = 1 WHERE id = ?"
    ).bind(imageId).run();
  }
  if (typeof body.sort_order === "number") {
    await c.env.DB.prepare(
      "UPDATE event_images SET sort_order = ? WHERE id = ?"
    ).bind(body.sort_order | 0, imageId).run();
  }
  if (body.alt_text !== undefined) {
    await c.env.DB.prepare(
      "UPDATE event_images SET alt_text = ? WHERE id = ?"
    ).bind(body.alt_text ? String(body.alt_text).trim() : null, imageId).run();
  }
  return c.json({ ok: true });
});

adminRoutes.delete("/api/admin/events/:id/images/:imageId", requireAdmin(), async (c) => {
  const { id: eventId, imageId } = c.req.param();
  const row = await c.env.DB.prepare(
    "SELECT r2_key FROM event_images WHERE id = ? AND event_id = ?"
  ).bind(imageId, eventId).first();
  if (!row) return c.notFound();
  await c.env.PHOTOS.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM event_images WHERE id = ?").bind(imageId).run();
  return c.json({ ok: true });
});

// --- attendees & moderation ------------------------------------------------

adminRoutes.get("/api/admin/events/:id/rsvps", requireAdmin(), async (c) => {
  const eventId = c.req.param("id");
  const rows = (await c.env.DB.prepare(
    "SELECT id, name, email, status, created_at FROM rsvps WHERE event_id = ? ORDER BY created_at ASC"
  ).bind(eventId).all()).results || [];
  return c.json({ rsvps: rows });
});

// Send a "you're invited, please RSVP" email to a list of addresses.
// Body: { emails: string[] }  — accepts a JSON array OR (for convenience) a
// newline/comma-separated string the client has already split.
// Does NOT pre-create RSVPs — recipients still click through and RSVP themselves.
adminRoutes.post("/api/admin/events/:id/invite", requireAdmin(), async (c) => {
  const eventId = c.req.param("id");
  let body;
  try { body = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }

  const event = await c.env.DB.prepare(
    "SELECT id, title, event_date, location, status FROM events WHERE id = ?"
  ).bind(eventId).first();
  if (!event) return c.notFound();
  if (event.status !== "active") return jsonError(c, 409, "event_not_active");

  // Normalise + dedupe + validate.
  const raw = Array.isArray(body?.emails) ? body.emails : [];
  const seen = new Set();
  const valid = [];
  const invalid = [];
  for (const r of raw) {
    const e = normalizeEmail(r);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    if (isValidEmail(e)) valid.push(e);
    else invalid.push(r);
  }
  if (valid.length === 0) return jsonError(c, 400, "no_valid_emails", { invalid });

  const eventUrl = `${c.env.SITE_URL}/event/${eventId}`;
  const niceDate = formatEventDate(c.env, event.event_date);
  const subject = `You're invited: ${event.title}`;
  const inviteBody = `You're invited to a hike:\n\n${event.title}\n${niceDate}${event.location ? `\n${event.location}` : ""}`;
  const { body: textBody, htmlBody } = composeEmail(c.env, {
    body: inviteBody,
    link: eventUrl,
    linkLabel: "Open the hike to RSVP",
  });

  const result = await sendEmail(c.env, { to: valid, subject, body: textBody, htmlBody });
  return c.json({
    ok: !!result.ok,
    sent: result.ok ? valid.length : 0,
    invalid_count: invalid.length,
  });
});

// Moderation: delete a member photo.
adminRoutes.delete("/api/admin/events/:id/photos/:photoId", requireAdmin(), async (c) => {
  const { id: eventId, photoId } = c.req.param();
  const row = await c.env.DB.prepare(
    "SELECT r2_key FROM member_photos WHERE id = ? AND event_id = ?"
  ).bind(photoId, eventId).first();
  if (!row) return c.notFound();
  await c.env.PHOTOS.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM member_photos WHERE id = ?").bind(photoId).run();
  return c.json({ ok: true });
});

// Manual "notify attendees" with a free-text update — short email + push fanout.
adminRoutes.post("/api/admin/events/:id/notify", requireAdmin(), async (c) => {
  const eventId = c.req.param("id");
  const event = await c.env.DB.prepare(
    "SELECT id, title, event_date, location, status FROM events WHERE id = ?"
  ).bind(eventId).first();
  if (!event) return c.notFound();

  let body;
  try { body = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }
  const message = String(body?.message || "").trim();
  if (!message) return jsonError(c, 400, "missing_message");

  // Persist the notify so it shows up on the public event page (today/upcoming hikes only).
  await c.env.DB.prepare(
    `INSERT INTO broadcasts (id, event_id, subject, body, sent_at, kind)
     VALUES (?, ?, ?, ?, ?, 'notify')`
  ).bind(uuid(), eventId, `Update: ${event.title}`, message, isoNow()).run();

  const result = await notifyAttendees(c, eventId, event, [], { customMessage: message });
  return c.json({ ok: true, ...result });
});

// --- helper: do the actual notification fan-out ----------------------------

async function notifyAttendees(c, eventId, event, changedFields, opts = {}) {
  const rsvps = (await c.env.DB.prepare(
    "SELECT name, email FROM rsvps WHERE event_id = ? AND status != 'cancelled'"
  ).bind(eventId).all()).results || [];

  // Build messaging copy. If `customMessage` is provided, lead with it. Otherwise
  // describe which fields changed so members know why they're being notified.
  const niceDate = formatEventDate(c.env, event.event_date);
  const subjectBase = `Update: ${event.title}`;
  const subject = opts.customMessage
    ? subjectBase
    : (event.status === "cancelled"
        ? `Cancelled: ${event.title}`
        : `${subjectBase} (${changedFields.join(", ")})`);

  const eventUrl = `${c.env.SITE_URL}/event/${eventId}`;
  const bodyParts = [];
  if (opts.customMessage) bodyParts.push(opts.customMessage);
  if (changedFields.length) bodyParts.push(`The organiser updated ${changedFields.join(", ")}.`);
  if (opts.cancelReason) bodyParts.push(`Reason: ${opts.cancelReason}`);
  bodyParts.push(
    `${event.title}${event.status === "cancelled" ? " — CANCELLED" : ""}\n` +
    `${niceDate}${event.location ? `\n${event.location}` : ""}`
  );
  const messageBody = bodyParts.join("\n\n");

  // Email everyone — per-recipient personalized so each gets a greeting by name.
  let emailsSent = 0;
  const messages = rsvps
    .filter((r) => r.email)
    .map((r) => {
      const { body, htmlBody } = composeEmail(c.env, {
        recipientName: r.name?.trim() || null,
        body: messageBody,
        link: eventUrl,
        linkLabel: "Event page",
      });
      return { to: r.email, subject, body, htmlBody };
    });
  const emailRecipients = messages.map((m) => m.to);
  if (messages.length > 0) {
    const r = await sendEmails(c.env, messages);
    if (r.ok) emailsSent = messages.length;
  }

  // Push everyone subscribed (matching by email, any number of devices each).
  let pushResult = { sent: 0, pruned: 0 };
  if (emailRecipients.length > 0) {
    const placeholders = emailRecipients.map(() => "?").join(",");
    const subs = (await c.env.DB.prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
        WHERE lower(email) IN (${placeholders})`
    ).bind(...emailRecipients.map(normalizeEmail)).all()).results || [];
    if (subs.length > 0) {
      const pushBody = opts.cancelReason
        ? `Reason: ${opts.cancelReason}`
        : opts.customMessage || `Updated: ${niceDate}${event.location ? " — " + event.location : ""}`;
      pushResult = await sendPushToSubscriptions(c.env, subs, {
        title: subject,
        body: pushBody,
        url: eventUrl,
      });
    }
  }

  return {
    recipients: emailRecipients.length,
    emails_sent: emailsSent,
    push_sent: pushResult.sent,
    push_pruned: pushResult.pruned,
  };
}
