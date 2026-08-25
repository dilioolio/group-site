// Private, per-hike member photo gallery.
// Access model: stateless gallery tokens scoped to ONE event + email.
//   - Issued by the RSVP handler (in the confirmation email).
//   - Issued on demand via request-access (but only if the email is on this hike's RSVP list).
//
// Storage layout: every file lives under KV key `member-photos/<event_id>/<uuid>.<ext>`.
// Each KV value gets an expirationTtl that lands at <event_date + 30 days>, so KV
// deletes the bytes automatically — the daily cron just sweeps the D1 metadata rows.
// Serving is ONLY through this module — never via /img/:key.

import { Hono } from "hono";
import { requireGalleryToken } from "../lib/gallery.js";
import { signGalleryToken } from "../lib/token.js";
import { sendEmail, composeEmail } from "../lib/email.js";
import {
  addDaysIso, isoNow, uuid, normalizeEmail, isValidEmail, jsonError, crc32,
} from "../lib/utils.js";
import { rateLimit, clientIp } from "../lib/ratelimit.js";

export const galleryRoutes = new Hono();

const ALLOWED_MIME = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
  ["image/gif", "gif"],
]);

// POST /api/events/:id/gallery/request-access — { email }
// Issues a fresh token IF the email is on this hike's RSVP list. Always responds
// with the same generic message so the RSVP list isn't probeable.
galleryRoutes.post("/api/events/:id/gallery/request-access", async (c) => {
  const eventId = c.req.param("id");
  let body;
  try { body = await c.req.json(); } catch { return jsonError(c, 400, "bad_json"); }
  const email = normalizeEmail(body?.email);
  if (!isValidEmail(email)) return jsonError(c, 400, "bad_email");

  // Sends an email when the address is on the RSVP list — throttle so it
  // can't be used to spam a member's inbox or drain the daily send quota.
  const ipLimit = await rateLimit(c.env, `galreq-ip:${clientIp(c)}`, 10, 3600);
  if (!ipLimit.allowed) return jsonError(c, 429, "rate_limited");
  const emailLimit = await rateLimit(c.env, `galreq-email:${email}`, 3, 3600);
  if (!emailLimit.allowed) return jsonError(c, 429, "rate_limited");

  const event = await c.env.DB.prepare(
    "SELECT id, title, gallery_enabled FROM events WHERE id = ?"
  ).bind(eventId).first();
  if (!event || !event.gallery_enabled) {
    // Still respond generically — don't reveal whether the event exists either.
    return c.json({ ok: true, message: "If you're signed up for this event, check your email." });
  }

  const member = await c.env.DB.prepare(
    "SELECT name FROM rsvps WHERE event_id = ? AND lower(email) = ? AND status != 'cancelled'"
  ).bind(eventId, email).first();

  if (member) {
    const ttl = Number(c.env.GALLERY_TOKEN_TTL_DAYS || 30);
    const token = await signGalleryToken(eventId, email, c.env.SESSION_SIGNING_KEY, ttl);
    const link = `${c.env.SITE_URL}/event/${eventId}/gallery?token=${token}`;
    const recipientName = member.name?.trim() || null;
    const { body, htmlBody } = composeEmail(c.env, {
      recipientName,
      body:
        `Here's your link to this event's photo gallery. It's valid for ${ttl} days. ` +
        `Photos auto-delete 30 days after the event.`,
      link,
      linkLabel: "Open the gallery",
    });
    c.executionCtx.waitUntil(sendEmail(c.env, {
      to: [email],
      subject: `Your photo gallery link — ${event.title}`,
      body,
      htmlBody,
    }));
  }

  return c.json({ ok: true, message: "If you're signed up for this event, check your email." });
});

// POST /api/events/:id/photos — multipart upload (token-gated, image-only, capped).
// Accepts up to 10 files per request via `files[]`. Single `file` is also accepted
// as a back-compat fallback. The uploader's name is derived from their RSVP row
// (single source of truth — no per-upload name field on the form).
galleryRoutes.post("/api/events/:id/photos", requireGalleryToken(), async (c) => {
  const eventId = c.req.param("id");
  const email = c.get("memberEmail");

  const event = await c.env.DB.prepare("SELECT id, event_date FROM events WHERE id = ?").bind(eventId).first();
  if (!event) return c.notFound();

  // Gallery closes 30 days after the hike — refuse new uploads past that point.
  const expiresAt = addDaysIso(30, new Date(event.event_date));
  const ttlSeconds = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
  if (ttlSeconds < 60) return jsonError(c, 409, "gallery_closed");

  const maxBytes = Number(c.env.MEMBER_PHOTO_MAX_BYTES || 8 * 1024 * 1024);
  const perEventCap = Number(c.env.MEMBER_PHOTO_PER_EVENT_CAP || 200);
  const perUploaderCap = Number(c.env.MEMBER_PHOTO_PER_UPLOADER_CAP || 30);
  const MAX_BATCH = 10;

  // Cheap pre-checks before reading the body.
  const eventTotal = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM member_photos WHERE event_id = ? AND expires_at > ?"
  ).bind(eventId, isoNow()).first())?.n || 0;
  if (eventTotal >= perEventCap) return jsonError(c, 409, "event_cap_reached");

  const uploaderTotal = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM member_photos WHERE event_id = ? AND lower(uploader_email) = ? AND expires_at > ?"
  ).bind(eventId, email, isoNow()).first())?.n || 0;
  if (uploaderTotal >= perUploaderCap) return jsonError(c, 409, "uploader_cap_reached");

  let form;
  try { form = await c.req.formData(); } catch { return jsonError(c, 400, "bad_form"); }
  const files = [];
  for (const v of form.getAll("files[]")) if (v instanceof File) files.push(v);
  const single = form.get("file");
  if (single instanceof File) files.push(single);
  if (files.length === 0) return jsonError(c, 400, "no_files");
  if (files.length > MAX_BATCH) return jsonError(c, 413, "too_many_files", { max: MAX_BATCH });

  // Whole-batch cap checks.
  if (eventTotal + files.length > perEventCap) return jsonError(c, 409, "event_cap_reached");
  if (uploaderTotal + files.length > perUploaderCap) return jsonError(c, 409, "uploader_cap_reached");

  // Pull the uploader's name from their RSVP. If the RSVP was deleted, leave null.
  const rsvp = await c.env.DB.prepare(
    "SELECT name FROM rsvps WHERE event_id = ? AND lower(email) = ?"
  ).bind(eventId, email).first();
  const uploaderName = rsvp?.name?.trim() || null;

  const created = [];
  for (const file of files) {
    const ext = ALLOWED_MIME.get(file.type);
    if (!ext) return jsonError(c, 415, "unsupported_type", { type: file.type });
    if (file.size <= 0) return jsonError(c, 400, "empty_file");
    if (file.size > maxBytes) return jsonError(c, 413, "file_too_large");

    const photoId = uuid();
    const r2Key = `member-photos/${eventId}/${photoId}.${ext}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // CRC-32 now so "Download all" doesn't have to hash every photo per zip
    // request. Skip very large files (un-resized HEIC) to stay inside the
    // free tier's per-request CPU budget — the zip falls back to hashing those.
    const fileCrc = bytes.length <= 4 * 1024 * 1024 ? crc32(bytes) : null;
    // TTL targets <hike date + 30 days> so KV bytes and D1 row expire together.
    await c.env.PHOTOS.put(r2Key, bytes, {
      metadata: { contentType: file.type, uploader: email, eventId },
      expirationTtl: ttlSeconds,
    });
    const now = isoNow();
    await c.env.DB.prepare(
      `INSERT INTO member_photos (id, event_id, r2_key, uploader_name, uploader_email, caption, created_at, expires_at, crc32)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    ).bind(photoId, eventId, r2Key, uploaderName, email, now, expiresAt, fileCrc).run();
    created.push({ id: photoId, expires_at: expiresAt });
  }

  return c.json({ ok: true, photos: created });
});

// GET /api/events/:id/photos — list non-expired photos for the hike.
galleryRoutes.get("/api/events/:id/photos", requireGalleryToken(), async (c) => {
  const eventId = c.req.param("id");
  const rows = (await c.env.DB.prepare(
    `SELECT id, uploader_name, caption, created_at, expires_at
       FROM member_photos
      WHERE event_id = ? AND expires_at > ?
      ORDER BY created_at DESC`
  ).bind(eventId, isoNow()).all()).results || [];

  // Derive "expires in N days" client-side, but also send the raw expires_at.
  return c.json({ photos: rows });
});

// GET /api/events/:id/photos/:photoId/file — token-gated file stream.
// Appending ?download=1 forces an attachment Content-Disposition.
galleryRoutes.get("/api/events/:id/photos/:photoId/file", requireGalleryToken(), async (c) => {
  const eventId = c.req.param("id");
  const photoId = c.req.param("photoId");

  const row = await c.env.DB.prepare(
    "SELECT r2_key, expires_at FROM member_photos WHERE id = ? AND event_id = ?"
  ).bind(photoId, eventId).first();
  if (!row || new Date(row.expires_at) < new Date()) return c.notFound();

  const { value, metadata } = await c.env.PHOTOS.getWithMetadata(row.r2_key, "stream");
  if (!value) return c.notFound();

  const headers = new Headers();
  headers.set("Content-Type", metadata?.contentType || "application/octet-stream");
  // Private cache only — never let an intermediary share these.
  headers.set("Cache-Control", "private, max-age=300");

  if (c.req.query("download")) {
    const ext = row.r2_key.split(".").pop() || "jpg";
    headers.set("Content-Disposition", `attachment; filename="${photoId}.${ext}"`);
  }
  return new Response(value, { headers });
});

// GET /api/events/:id/photos/zip — optional "Download all" bundle.
// Generates a tiny streamed STORE-only zip (no compression — photos are already compressed).
galleryRoutes.get("/api/events/:id/photos/zip", requireGalleryToken(), async (c) => {
  const eventId = c.req.param("id");
  const rows = (await c.env.DB.prepare(
    `SELECT id, r2_key, crc32 FROM member_photos WHERE event_id = ? AND expires_at > ?
      ORDER BY created_at DESC`
  ).bind(eventId, isoNow()).all()).results || [];
  if (rows.length === 0) return jsonError(c, 404, "no_photos");

  const { stream, filename } = await buildZipStream(c.env, rows, eventId);
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
});

// --- Minimal streaming STORE-only ZIP builder ------------------------------
// Spec: PKWARE APPNOTE.TXT (no encryption, no compression, no Zip64).
// Suitable for tens to a few hundred small-to-medium photos.
// CRCs come from the member_photos row when available (computed at upload);
// anything we DO have to hash here gets written back so it's a one-time cost.
async function buildZipStream(env, rows, eventId) {
  const bucket = env.PHOTOS;
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const filename = `${eventId}-photos.zip`;
  const centralEntries = [];
  const computedCrcs = []; // {id, crc} for rows missing a stored crc32
  let offset = 0;

  (async () => {
    try {
      for (const row of rows) {
        const buf = await bucket.get(row.r2_key, "arrayBuffer");
        if (!buf) continue;
        const data = new Uint8Array(buf); // hold one file at a time
        const name = `${row.id}.${(row.r2_key.split(".").pop() || "jpg")}`;
        const nameBytes = encoder.encode(name);
        let crc = row.crc32;
        if (typeof crc !== "number") {
          crc = crc32(data);
          computedCrcs.push({ id: row.id, crc });
        }
        const size = data.length;

        // Local file header
        const local = new Uint8Array(30 + nameBytes.length);
        const dv = new DataView(local.buffer);
        dv.setUint32(0, 0x04034b50, true);                // signature
        dv.setUint16(4, 20, true);                        // version needed
        dv.setUint16(6, 0, true);                         // flags
        dv.setUint16(8, 0, true);                         // method: store
        dv.setUint16(10, 0, true);                        // mod time
        dv.setUint16(12, 0, true);                        // mod date
        dv.setUint32(14, crc, true);
        dv.setUint32(18, size, true);                     // compressed
        dv.setUint32(22, size, true);                     // uncompressed
        dv.setUint16(26, nameBytes.length, true);
        dv.setUint16(28, 0, true);                        // extra field length
        local.set(nameBytes, 30);

        await writer.write(local);
        await writer.write(data);

        centralEntries.push({ name: nameBytes, crc, size, offset });
        offset += local.length + size;
      }

      // Central directory
      const centralStart = offset;
      let centralSize = 0;
      for (const e of centralEntries) {
        const c = new Uint8Array(46 + e.name.length);
        const dv = new DataView(c.buffer);
        dv.setUint32(0, 0x02014b50, true);
        dv.setUint16(4, 20, true);                        // version made by
        dv.setUint16(6, 20, true);                        // version needed
        dv.setUint16(8, 0, true);                         // flags
        dv.setUint16(10, 0, true);                        // method
        dv.setUint16(12, 0, true);                        // mod time
        dv.setUint16(14, 0, true);                        // mod date
        dv.setUint32(16, e.crc, true);
        dv.setUint32(20, e.size, true);
        dv.setUint32(24, e.size, true);
        dv.setUint16(28, e.name.length, true);
        dv.setUint16(30, 0, true);                        // extra
        dv.setUint16(32, 0, true);                        // comment
        dv.setUint16(34, 0, true);                        // disk number
        dv.setUint16(36, 0, true);                        // internal attrs
        dv.setUint32(38, 0, true);                        // external attrs
        dv.setUint32(42, e.offset, true);
        c.set(e.name, 46);
        await writer.write(c);
        centralSize += c.length;
      }

      // EOCD
      const eocd = new Uint8Array(22);
      const dv = new DataView(eocd.buffer);
      dv.setUint32(0, 0x06054b50, true);
      dv.setUint16(4, 0, true);                           // disk number
      dv.setUint16(6, 0, true);                           // disk with central
      dv.setUint16(8, centralEntries.length, true);       // entries on disk
      dv.setUint16(10, centralEntries.length, true);      // total entries
      dv.setUint32(12, centralSize, true);
      dv.setUint32(16, centralStart, true);
      dv.setUint16(20, 0, true);                          // comment length
      await writer.write(eocd);

      // Cache any freshly computed CRCs so the next zip skips the hashing.
      if (computedCrcs.length > 0) {
        const stmt = env.DB.prepare("UPDATE member_photos SET crc32 = ? WHERE id = ?");
        await env.DB.batch(computedCrcs.map(({ id, crc }) => stmt.bind(crc, id)));
      }
    } catch (err) {
      console.error("zip stream error:", err?.message || err);
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  return { stream: readable, filename };
}
